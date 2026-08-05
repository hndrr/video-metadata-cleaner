import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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

type VideoJob = {
  inputPath: string;
  outputPath?: string;
  status: JobStatus;
  error?: string;
  before?: MetadataReport;
  after?: MetadataReport;
  inspectError?: string;
  inspecting?: boolean;
  showMeta?: boolean;
};

type CleanResult = {
  outputPath: string;
  stderr: string;
};

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v"]);

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

const isVideoPath = (path: string): boolean => VIDEO_EXTENSIONS.has(extensionOf(path));

export default function App() {
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const pendingCount = useMemo(
    () => jobs.filter((job) => job.status === "ready" || job.status === "error").length,
    [jobs],
  );

  const doneCount = useMemo(
    () => jobs.filter((job) => job.status === "done").length,
    [jobs],
  );

  const addPaths = useCallback((paths: string[]): void => {
    const videos = paths.filter(isVideoPath);
    if (videos.length === 0) return;

    setJobs((current) => {
      const existing = new Set(current.map((job) => job.inputPath));
      const additions = videos
        .filter((path) => !existing.has(path))
        .map<VideoJob>((inputPath) => ({ inputPath, status: "ready" }));
      return [...current, ...additions];
    });
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
          addPaths(event.payload.paths);
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
  }, [addPaths]);

  const selectVideos = async (): Promise<void> => {
    const selected = await open({
      multiple: true,
      title: "動画を選択",
      filters: [
        {
          name: "Video",
          extensions: ["mp4", "mov", "m4v"],
        },
      ],
    });

    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    addPaths(paths);
  };

  const updateJob = (inputPath: string, patch: Partial<VideoJob>): void => {
    setJobs((current) =>
      current.map((job) => (job.inputPath === inputPath ? { ...job, ...patch } : job)),
    );
  };

  const inspectJob = async (job: VideoJob): Promise<void> => {
    updateJob(job.inputPath, { inspecting: true, inspectError: undefined, showMeta: true });

    try {
      const before = await invoke<MetadataReport>("inspect_metadata", {
        path: job.inputPath,
      });

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

  const cleanAll = async (): Promise<void> => {
    if (isRunning) return;
    setIsRunning(true);

    const targets = jobs.filter((job) => job.status === "ready" || job.status === "error");

    for (const job of targets) {
      updateJob(job.inputPath, {
        status: "processing",
        error: undefined,
        after: undefined,
        inspectError: undefined,
      });

      try {
        // Capture before metadata while cleaning, if not already loaded.
        let before = job.before;
        if (!before) {
          try {
            before = await invoke<MetadataReport>("inspect_metadata", {
              path: job.inputPath,
            });
          } catch {
            // Inspection is best-effort; cleaning should still proceed.
          }
        }

        const result = await invoke<CleanResult>("clean_video", {
          inputPath: job.inputPath,
        });

        let after: MetadataReport | undefined;
        try {
          after = await invoke<MetadataReport>("inspect_metadata", {
            path: result.outputPath,
          });
        } catch (error) {
          updateJob(job.inputPath, {
            status: "done",
            outputPath: result.outputPath,
            before,
            inspecting: false,
            showMeta: true,
            inspectError: error instanceof Error ? error.message : String(error),
          });
          continue;
        }

        updateJob(job.inputPath, {
          status: "done",
          outputPath: result.outputPath,
          before,
          after,
          inspecting: false,
          showMeta: true,
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

  return (
    <main className="app-shell">
      <header className="header">
        <div>
          <p className="eyebrow">macOS / lossless remux</p>
          <h1>Video Metadata Cleaner</h1>
          <p className="description">
            映像・音声を再エンコードせず、MP4/MOVのメタデータ、チャプター、C2PA/JUMBF領域を引き継がずに
            保存します。処理後は ExifTool で前後を自動比較します。
          </p>
        </div>
      </header>

      <section className="toolbar">
        <button className="button primary" onClick={selectVideos} disabled={isRunning}>
          動画を選択
        </button>
        <button
          className="button"
          onClick={cleanAll}
          disabled={isRunning || pendingCount === 0}
        >
          {isRunning ? "処理中…" : `${pendingCount}件をクリーンアップ`}
        </button>
        <button
          className="button ghost"
          onClick={clearFinished}
          disabled={isRunning || doneCount === 0}
          title="処理が完了した項目を一覧から外します。ファイル自体は削除しません。"
        >
          完了をリストから外す
        </button>
      </section>

      <section className={`panel ${isDragging ? "panel-dragging" : ""}`}>
        {jobs.length === 0 ? (
          <div className={`empty ${isDragging ? "empty-dragging" : ""}`}>
            <strong>
              {isDragging ? "ここにドロップ" : "動画が選択されていません"}
            </strong>
            <span>
              ファイルをドラッグ＆ドロップするか、「動画を選択」から追加できます。
            </span>
            <span>対応形式: MP4 / MOV / M4V · 出力は元と同じ場所の cleaned フォルダ</span>
          </div>
        ) : (
          <ul className="job-list">
            {isDragging && (
              <li className="drop-hint" aria-hidden>
                追加の動画をドロップできます
              </li>
            )}
            {jobs.map((job) => (
              <li className="job" key={job.inputPath}>
                <div className="job-row">
                  <div className="job-main">
                    <span className={`status status-${job.status}`}>
                      {STATUS_LABEL[job.status]}
                    </span>
                    <div className="job-text">
                      <strong>{fileName(job.inputPath)}</strong>
                      <span title={job.inputPath}>{job.inputPath}</span>
                      {job.error && <span className="error">{job.error}</span>}
                      {job.inspectError && (
                        <span className="error">ExifTool: {job.inspectError}</span>
                      )}
                      {job.after && (
                        <span className={job.after.flagged.length > 0 ? "meta-warn" : "meta-ok"}>
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
                      onClick={() => inspectJob(job)}
                      disabled={isRunning || job.inspecting}
                      title="ExifTool でメタデータを前後比較"
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
                    <MetaPanel title="処理後（cleaned）" report={job.after} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="footer">
        <code>
          -c copy -map_metadata -1 -map_metadata:s -1 -map_chapters -1 -fflags +bitexact
        </code>
        <p className="footer-note">
          「完了をリストから外す」はアプリ内の一覧だけを整理します。元動画も cleaned
          フォルダの出力も削除しません。
        </p>
      </footer>
    </main>
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
