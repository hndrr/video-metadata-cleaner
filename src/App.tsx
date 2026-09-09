import { useCallback, useEffect, useMemo, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

type JobStatus = "ready" | "processing" | "done" | "error";

type MetadataReport = {
  path: string;
  raw: string;
  flagged: string[];
  lineCount: number;
};

type MediaJob = {
  inputPath: string;
  outputPath?: string;
  status: JobStatus;
  error?: string;
  before?: MetadataReport;
  after?: MetadataReport;
  inspectError?: string;
  inspecting?: boolean;
  showMeta?: boolean;
  overwritten?: boolean;
  /** クリーンアップ対象として選択されているか */
  selected: boolean;
};

type CleanResult = {
  outputPath: string;
  stderr: string;
  overwritten: boolean;
};

type PlaybackTarget = {
  path: string;
  label: string;
};

const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "wav", "flac"]);
const MEDIA_EXTENSIONS = new Set(["mp4", "mov", "m4v", ...AUDIO_EXTENSIONS]);

const STATUS_LABEL: Record<JobStatus, string> = {
  ready: "待機",
  processing: "処理中",
  done: "完了",
  error: "エラー",
};

const fileName = (path: string): string => path.split("/").at(-1) ?? path;

const extensionOf = (path: string): string => {
  const name = fileName(path);
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
};

const isMediaPath = (path: string): boolean => MEDIA_EXTENSIONS.has(extensionOf(path));

const isCleanable = (job: MediaJob): boolean =>
  job.status === "ready" || job.status === "error";

type ExifToolStatus =
  | { state: "checking" }
  | { state: "ready"; version: string }
  | { state: "missing"; message: string };

export default function App() {
  const [jobs, setJobs] = useState<MediaJob[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  /** true: 元ファイルを一時ファイル経由で置き換え / false: cleaned/ に新規出力 */
  const [overwriteMode, setOverwriteMode] = useState(false);
  const [playback, setPlayback] = useState<PlaybackTarget | null>(null);
  const [exiftool, setExiftool] = useState<ExifToolStatus>({ state: "checking" });

  const exiftoolReady = exiftool.state === "ready";

  const selectedCleanableCount = useMemo(
    () => jobs.filter((job) => job.selected && isCleanable(job)).length,
    [jobs],
  );

  const cleanableCount = useMemo(
    () => jobs.filter(isCleanable).length,
    [jobs],
  );

  const doneCount = useMemo(
    () => jobs.filter((job) => job.status === "done").length,
    [jobs],
  );

  const allCleanableSelected =
    cleanableCount > 0 &&
    jobs.filter(isCleanable).every((job) => job.selected);

  const addPaths = useCallback((paths: string[]): void => {
    const media = paths.filter(isMediaPath);
    if (media.length === 0) return;

    setJobs((current) => {
      const existing = new Set(current.map((job) => job.inputPath));
      const additions = media
        .filter((path) => !existing.has(path))
        .map<MediaJob>((inputPath) => ({
          inputPath,
          status: "ready",
          selected: true,
        }));
      return [...current, ...additions];
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const version = await invoke<string>("check_exiftool");
        if (!cancelled) {
          setExiftool({ state: "ready", version });
        }
      } catch (error) {
        if (!cancelled) {
          setExiftool({
            state: "missing",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      const dispose = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setIsDragging(true);
        } else if (event.payload.type === "leave") {
          setIsDragging(false);
        } else if (event.payload.type === "drop") {
          setIsDragging(false);
          if (exiftoolReady) {
            addPaths(event.payload.paths);
          }
        }
      });

      if (cancelled) {
        dispose();
      } else {
        unlisten = dispose;
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [addPaths, exiftoolReady]);

  const selectMedia = async (): Promise<void> => {
    const selected = await open({
      multiple: true,
      title: "動画・音声を選択",
      filters: [
        {
          name: "Video / Audio",
          extensions: [...MEDIA_EXTENSIONS],
        },
      ],
    });

    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    addPaths(paths);
  };

  const updateJob = (inputPath: string, patch: Partial<MediaJob>): void => {
    setJobs((current) =>
      current.map((job) => (job.inputPath === inputPath ? { ...job, ...patch } : job)),
    );
  };

  const toggleJobSelected = (inputPath: string): void => {
    setJobs((current) =>
      current.map((job) =>
        job.inputPath === inputPath ? { ...job, selected: !job.selected } : job,
      ),
    );
  };

  const setAllCleanableSelected = (selected: boolean): void => {
    setJobs((current) =>
      current.map((job) => (isCleanable(job) ? { ...job, selected } : job)),
    );
  };

  const inspectJob = async (job: MediaJob): Promise<void> => {
    if (!exiftoolReady) return;

    updateJob(job.inputPath, { inspecting: true, inspectError: undefined, showMeta: true });

    try {
      // 上書き後は input が処理済みになるので、処理前スナップショットがあれば保持する
      let before = job.before;
      const samePath =
        !!job.outputPath && job.outputPath === job.inputPath && !!job.overwritten;

      if (!before || !samePath) {
        before = await invoke<MetadataReport>("inspect_metadata", {
          path: job.inputPath,
        });
      }

      let after: MetadataReport | undefined;
      if (job.outputPath) {
        after = await invoke<MetadataReport>("inspect_metadata", {
          path: job.outputPath,
        });
      }

      updateJob(job.inputPath, {
        before,
        after,
        inspecting: false,
        showMeta: true,
      });
    } catch (error) {
      updateJob(job.inputPath, {
        inspecting: false,
        inspectError: error instanceof Error ? error.message : String(error),
        showMeta: true,
      });
    }
  };

  const recheckExiftool = async (): Promise<void> => {
    setExiftool({ state: "checking" });
    try {
      const version = await invoke<string>("check_exiftool");
      setExiftool({ state: "ready", version });
    } catch (error) {
      setExiftool({
        state: "missing",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const cleanSelected = async (): Promise<void> => {
    if (isRunning || !exiftoolReady) return;

    const targets = jobs.filter((job) => job.selected && isCleanable(job));
    if (targets.length === 0) return;

    if (overwriteMode) {
      const ok = window.confirm(
        `上書きモードです。\n選択中の ${targets.length} 件の元ファイルを置き換えます。\n元に戻せません。続行しますか？`,
      );
      if (!ok) return;
    }

    setIsRunning(true);

    for (const job of targets) {
      updateJob(job.inputPath, {
        status: "processing",
        error: undefined,
        after: undefined,
        inspectError: undefined,
        overwritten: undefined,
      });

      try {
        // 処理前メタデータ（必須）
        let before = job.before;
        if (!before) {
          before = await invoke<MetadataReport>("inspect_metadata", {
            path: job.inputPath,
          });
        }

        const result = await invoke<CleanResult>("clean_video", {
          inputPath: job.inputPath,
          overwrite: overwriteMode,
        });

        const after = await invoke<MetadataReport>("inspect_metadata", {
          path: result.outputPath,
        });

        updateJob(job.inputPath, {
          status: "done",
          outputPath: result.outputPath,
          overwritten: result.overwritten,
          before,
          after,
          inspecting: false,
          showMeta: true,
          selected: false,
        });
      } catch (error) {
        updateJob(job.inputPath, {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    setIsRunning(false);
  };

  /** 完了したジョブをリストから外すだけ。出力ファイルは消さない。 */
  const clearFinished = (): void => {
    setJobs((current) => current.filter((job) => job.status !== "done"));
  };

  const playMedia = (path: string, label: string): void => {
    setPlayback({ path, label });
  };

  return (
    <main className="app-shell">
      <header className="header">
        <div>
          <p className="eyebrow">macOS / lossless remux</p>
          <h1>Video Metadata Cleaner</h1>
          <p className="description">
            動画・音声を再エンコードせず、メタデータとチャプターを引き継がずに保存します。
            音声ファイルはカバー画像も削除します。処理後は ExifTool で前後を自動比較します。
          </p>
        </div>
      </header>

      <section className="toolbar">
        <button
          className="button primary"
          onClick={selectMedia}
          disabled={isRunning || !exiftoolReady}
        >
          動画・音声を選択
        </button>
        <button
          className={`button ${overwriteMode ? "danger" : ""}`}
          onClick={cleanSelected}
          disabled={isRunning || !exiftoolReady || selectedCleanableCount === 0}
          title={
            !exiftoolReady
              ? "ExifTool が必要です"
              : selectedCleanableCount === 0
                ? "クリーンアップする項目にチェックを入れてください"
                : "チェックした項目だけをクリーンアップします"
          }
        >
          {isRunning
            ? "処理中…"
            : overwriteMode
              ? `選択 ${selectedCleanableCount} 件を上書きクリーンアップ`
              : `選択 ${selectedCleanableCount} 件をクリーンアップ`}
        </button>
        <button
          className="button ghost"
          onClick={clearFinished}
          disabled={isRunning || doneCount === 0}
          title="処理が完了した項目を一覧から外します。ファイル自体は削除しません。"
        >
          完了をリストから外す
        </button>

        {cleanableCount > 0 && (
          <div className="selection-controls">
            <button
              className="button compact ghost"
              onClick={() => setAllCleanableSelected(!allCleanableSelected)}
              disabled={isRunning || !exiftoolReady}
              title="待機・エラーの項目の選択を切り替えます"
            >
              {allCleanableSelected ? "選択を解除" : "すべて選択"}
            </button>
            <span className="selection-hint">
              {selectedCleanableCount}/{cleanableCount} 件選択
            </span>
          </div>
        )}

        <label
          className={`toggle ${overwriteMode ? "toggle-on" : ""} ${isRunning || !exiftoolReady ? "toggle-disabled" : ""}`}
          title="オンにすると cleaned/ を作らず、元ファイルを置き換えます（一時ファイル経由）"
        >
          <input
            type="checkbox"
            checked={overwriteMode}
            disabled={isRunning || !exiftoolReady}
            onChange={(event) => setOverwriteMode(event.target.checked)}
          />
          <span className="toggle-ui" aria-hidden />
          <span className="toggle-label">上書きモード</span>
        </label>
      </section>

      {exiftool.state === "checking" && (
        <p className="info-banner" role="status">
          ExifTool を確認しています…
        </p>
      )}

      {exiftool.state === "missing" && (
        <div className="error-banner" role="alert">
          <div>
            <strong>ExifTool が必須です</strong>
            <p>
              {exiftool.message} インストール後、「再確認」を押してください。
            </p>
            <code>brew install exiftool</code>
          </div>
          <button className="button compact" onClick={recheckExiftool}>
            再確認
          </button>
        </div>
      )}

      {overwriteMode && exiftoolReady && (
        <p className="overwrite-banner" role="status">
          上書きモード: 元ファイルを置き換えます（先に一時ファイルへ書き出してから差し替え）。
          取り消せません。
        </p>
      )}

      <section className={`panel ${isDragging ? "panel-dragging" : ""}`}>
        {jobs.length === 0 ? (
          <div className={`empty ${isDragging ? "empty-dragging" : ""}`}>
            <strong>
              {isDragging ? "ここにドロップ" : "動画・音声が選択されていません"}
            </strong>
            <span>
              ファイルをドラッグ＆ドロップするか、「動画・音声を選択」から追加できます。
            </span>
            <span>
              対応形式: MP4 / MOV / M4V / MP3 / M4A / WAV / FLAC ·{" "}
              {overwriteMode
                ? "出力: 元ファイルを上書き"
                : "出力: 元と同じ場所の cleaned フォルダ"}
            </span>
          </div>
        ) : (
          <ul className="job-list">
            {isDragging && (
              <li className="drop-hint" aria-hidden>
                追加の動画・音声をドロップできます
              </li>
            )}
            {jobs.map((job) => {
              const canClean = isCleanable(job);
              return (
                <li
                  className={`job ${job.selected && canClean ? "job-selected" : ""}`}
                  key={job.inputPath}
                >
                  <div className="job-row">
                    <div className="job-main">
                      <label
                        className={`job-check ${!canClean ? "job-check-disabled" : ""}`}
                        title={
                          canClean
                            ? "クリーンアップ対象に含める"
                            : "完了・処理中の項目は選択できません"
                        }
                      >
                        <input
                          type="checkbox"
                          checked={job.selected && canClean}
                          disabled={isRunning || !canClean}
                          onChange={() => toggleJobSelected(job.inputPath)}
                        />
                        <span className="job-check-ui" aria-hidden />
                      </label>
                      <span className={`status status-${job.status}`}>
                        {STATUS_LABEL[job.status]}
                      </span>
                      <div className="job-text">
                        <strong>{fileName(job.inputPath)}</strong>
                        <span title={job.inputPath}>{job.inputPath}</span>
                        {job.overwritten && job.status === "done" && (
                          <span className="meta-warn">元ファイルを上書き済み</span>
                        )}
                        {job.error && <span className="error">{job.error}</span>}
                        {job.inspectError && (
                          <span className="error">ExifTool: {job.inspectError}</span>
                        )}
                        {job.after && (
                          <span
                            className={
                              job.after.flagged.length > 0 ? "meta-warn" : "meta-ok"
                            }
                          >
                            {job.after.flagged.length > 0
                              ? `処理後も要注意タグ ${job.after.flagged.length} 件`
                              : `処理後: 要注意タグなし（${job.after.lineCount} 行）`}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="job-actions">
                      <button
                        className="button compact"
                        onClick={() =>
                          playMedia(job.inputPath, `入力 · ${fileName(job.inputPath)}`)
                        }
                        disabled={isRunning && job.status === "processing"}
                        title="入力ファイルを再生"
                      >
                        再生
                      </button>
                      {job.outputPath && job.outputPath !== job.inputPath && (
                        <button
                          className="button compact"
                          onClick={() =>
                            playMedia(
                              job.outputPath!,
                              `出力 · ${fileName(job.outputPath!)}`,
                            )
                          }
                          title="クリーンアップ後のファイルを再生"
                        >
                          出力を再生
                        </button>
                      )}
                      <button
                        className="button compact"
                        onClick={() => inspectJob(job)}
                        disabled={isRunning || !exiftoolReady || job.inspecting}
                        title={
                          exiftoolReady
                            ? "ExifTool でメタデータを前後比較"
                            : "ExifTool が必要です"
                        }
                      >
                        {job.inspecting ? "検査中…" : "メタデータ確認"}
                      </button>
                      {job.outputPath && (
                        <button
                          className="button compact"
                          onClick={() => revealItemInDir(job.outputPath!)}
                        >
                          Finderで表示
                        </button>
                      )}
                      {(job.before || job.after || job.inspectError) && (
                        <button
                          className="button compact ghost"
                          onClick={() =>
                            updateJob(job.inputPath, { showMeta: !job.showMeta })
                          }
                        >
                          {job.showMeta ? "詳細を隠す" : "詳細を表示"}
                        </button>
                      )}
                    </div>
                  </div>

                  {job.showMeta && (job.before || job.after) && (
                    <div className="meta-compare">
                      <MetaPanel title="処理前（入力）" report={job.before} />
                      <MetaPanel
                        title={
                          job.overwritten ? "処理後（上書き）" : "処理後（cleaned）"
                        }
                        report={job.after}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <footer className="footer">
        <code>
          -c copy -map_metadata -1 -map_metadata:s -1 -map_chapters -1 -fflags +bitexact
        </code>
        <p className="footer-note">
          チェックした項目だけクリーンアップします。既定は cleaned/
          へ新規保存。上書きモードは元ファイルを置き換えます。
          「完了をリストから外す」は一覧の整理のみで、ファイルは削除しません。
          {exiftool.state === "ready" && (
            <> · ExifTool {exiftool.version}</>
          )}
        </p>
      </footer>

      {playback && (
        <MediaPlayerModal
          path={playback.path}
          label={playback.label}
          onClose={() => setPlayback(null)}
        />
      )}
    </main>
  );
}

function MediaPlayerModal({
  path,
  label,
  onClose,
}: {
  path: string;
  label: string;
  onClose: () => void;
}) {
  const src = useMemo(() => convertFileSrc(path), [path]);
  const isAudio = AUDIO_EXTENSIONS.has(extensionOf(path));
  const [playbackError, setPlaybackError] = useState(false);

  useEffect(() => setPlaybackError(false), [path]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="player-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={isAudio ? "音声プレビュー" : "動画プレビュー"}
      onClick={onClose}
    >
      <div className="player-modal" onClick={(event) => event.stopPropagation()}>
        <div className="player-header">
          <div className="player-title">
            <strong>{label}</strong>
            <span title={path}>{path}</span>
          </div>
          <button className="button compact ghost" onClick={onClose}>
            閉じる
          </button>
        </div>
        {isAudio ? (
          <audio key={path} className="player-audio" src={src} controls autoPlay onError={() => setPlaybackError(true)}>
            この環境では音声を再生できません。
          </audio>
        ) : (
          <video key={path} className="player-video" src={src} controls autoPlay playsInline onError={() => setPlaybackError(true)}>
            この環境では動画を再生できません。
          </video>
        )}
        {playbackError && (
          <p className="player-error" role="alert">
            この環境ではプレビューを再生できません。ファイル一覧の「Finderで表示」から外部プレーヤーで確認してください。
          </p>
        )}
      </div>
    </div>
  );
}

type ParsedTag = {
  group: string;
  tag: string;
  value: string;
  flagged: boolean;
  source: string;
};

/** ExifTool `-G1 -a -s` の1行をパースする。例: `[QuickTime] CreateDate : 2024:01:01 ...` */
function parseExifLine(line: string, flagged = false): ParsedTag {
  const source = line.trim();
  const match = source.match(/^\[([^\]]+)\]\s+(\S+)\s*:\s*(.*)$/);
  if (!match) {
    return { group: "—", tag: "—", value: source, flagged, source };
  }

  return {
    group: match[1],
    tag: match[2],
    value: formatTagValue(match[3].trim()),
    flagged,
    source,
  };
}

/** 配列っぽい値や長い JSON を読みやすくする */
function formatTagValue(value: string): string {
  if (!value) return "—";

  // exiftool -j 風の配列: ["a","b"] や isom, iso2 はそのまま見やすく
  if (
    (value.startsWith("[") && value.endsWith("]")) ||
    (value.startsWith("{") && value.endsWith("}"))
  ) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item)).join(", ");
      }
      if (parsed !== null && typeof parsed === "object") {
        return Object.entries(parsed as Record<string, unknown>)
          .map(([key, val]) => `${key}: ${String(val)}`)
          .join(" · ");
      }
      return String(parsed);
    } catch {
      // not valid JSON; fall through
    }
  }

  return value;
}

function parseExifReport(report: MetadataReport): ParsedTag[] {
  const flaggedSet = new Set(report.flagged.map((line) => line.trim()));
  return report.raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => parseExifLine(line, flaggedSet.has(line)));
}

function MetaTable({
  rows,
  emptyLabel,
  variant = "all",
}: {
  rows: ParsedTag[];
  emptyLabel: string;
  variant?: "all" | "flagged";
}) {
  if (rows.length === 0) {
    return <p className="meta-empty">{emptyLabel}</p>;
  }

  return (
    <div className={`meta-table-wrap meta-table-wrap-${variant}`}>
      <table className="meta-table">
        <thead>
          <tr>
            <th>グループ</th>
            <th>タグ</th>
            <th>値</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={`${row.group}-${row.tag}-${index}`}
              className={row.flagged ? "meta-row-flagged" : undefined}
            >
              <td className="meta-group">{row.group}</td>
              <td className="meta-tag">{row.tag}</td>
              <td className="meta-value">{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MetaPanel({
  title,
  report,
}: {
  title: string;
  report?: MetadataReport;
}) {
  const allRows = useMemo(
    () => (report ? parseExifReport(report) : []),
    [report],
  );
  const flaggedRows = useMemo(
    () => allRows.filter((row) => row.flagged),
    [allRows],
  );

  if (!report) {
    return (
      <div className="meta-panel">
        <h3>{title}</h3>
        <p className="meta-empty">まだありません</p>
      </div>
    );
  }

  return (
    <div className="meta-panel">
      <h3>
        {title}
        <span className="meta-count">
          {allRows.length} 行 / 要注意 {flaggedRows.length}
        </span>
      </h3>

      {flaggedRows.length > 0 && (
        <div className="meta-flagged">
          <strong>要注意タグ</strong>
          <MetaTable
            rows={flaggedRows}
            emptyLabel="要注意タグはありません"
            variant="flagged"
          />
        </div>
      )}

      <div className="meta-all">
        <strong>すべてのタグ</strong>
        <MetaTable
          rows={allRows}
          emptyLabel="メタデータがありません"
          variant="all"
        />
      </div>
    </div>
  );
}
