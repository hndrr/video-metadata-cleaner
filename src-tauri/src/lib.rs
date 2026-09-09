use serde::Serialize;
use std::{
    env, fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanResult {
    output_path: String,
    stderr: String,
    /// true のとき元ファイルを一時ファイル経由で置き換えた
    overwritten: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MetadataReport {
    path: String,
    raw: String,
    flagged: Vec<String>,
    line_count: usize,
}

const FLAGGED_KEYWORDS: &[&str] = &[
    "JUMBF",
    "CBOR",
    "C2PA",
    "ContentIdentifier",
    "Grok",
    "SpaceXAI",
    "Signature",
    "XMP",
    "IPTC",
    "GPS",
    "Make",
    "Model",
    "Software",
    "Encoder",
    "Comment",
    "Description",
    "Title",
    "Artist",
    "Author",
    "Copyright",
    "Creator",
    "Location",
    "UserData",
    "HandlerDescription",
    "CompressorID",
    "Vendor",
    "CompatibleBrands",
    "MajorBrand",
    "CreationDate",
    "CreateDate",
    "ModifyDate",
    "MediaCreateDate",
    "TrackCreateDate",
    "DateTimeOriginal",
];

/// Finder から起動した macOS アプリは、シェルの PATH を引き継がないことがある。
/// まず PATH と明示設定を確認し、その後 Homebrew / MacPorts の標準パスを確認する。
fn resolve_exiftool() -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(path) = env::var_os("EXIFTOOL_PATH") {
        candidates.push(PathBuf::from(path));
    }

    if let Some(path) = env::var_os("PATH") {
        candidates.extend(env::split_paths(&path).map(|directory| directory.join("exiftool")));
    }

    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/exiftool"),
        PathBuf::from("/usr/local/bin/exiftool"),
        PathBuf::from("/opt/local/bin/exiftool"),
    ]);

    candidates.into_iter().find(|path| is_executable_file(path))
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    path.is_file()
        && path
            .metadata()
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

fn exiftool_missing_message() -> String {
    "exiftool が見つかりません。Homebrew または MacPorts でインストールするか、EXIFTOOL_PATH を設定してください。".to_string()
}

fn validate_input(path: &PathBuf) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!("入力ファイルが見つかりません: {}", path.display()));
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();

    if !matches!(
        extension.as_str(),
        "mp4" | "mov" | "m4v" | "mp3" | "m4a" | "wav" | "flac"
    ) {
        return Err(format!("未対応の形式です: .{extension}"));
    }

    Ok(())
}

fn run_exiftool(path: &Path) -> Result<MetadataReport, String> {
    if !path.is_file() {
        return Err(format!("ファイルが見つかりません: {}", path.display()));
    }

    let exiftool = resolve_exiftool().ok_or_else(exiftool_missing_message)?;
    let output = Command::new(exiftool)
        .args(["-G1", "-a", "-s", "-api", "largefilesupport=1"])
        .arg(path)
        .output()
        .map_err(|error| {
            if error.kind() == ErrorKind::NotFound {
                exiftool_missing_message()
            } else {
                format!("exiftool の実行に失敗しました: {error}")
            }
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    if !output.status.success() {
        return Err(if stderr.trim().is_empty() {
            "exiftool が異常終了しました".to_string()
        } else {
            stderr
        });
    }

    let flagged = stdout
        .lines()
        .filter(|line| {
            FLAGGED_KEYWORDS.iter().any(|keyword| {
                line.to_ascii_lowercase()
                    .contains(&keyword.to_ascii_lowercase())
            })
        })
        .map(str::to_string)
        .collect::<Vec<_>>();

    let line_count = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();

    Ok(MetadataReport {
        path: path.to_string_lossy().into_owned(),
        raw: stdout,
        flagged,
        line_count,
    })
}

/// FFmpeg の出力先パスを決める。上書き時は同ディレクトリの一時ファイル。
fn resolve_output_paths(input: &Path, overwrite: bool) -> Result<(PathBuf, PathBuf, bool), String> {
    let parent = input
        .parent()
        .ok_or_else(|| "入力ファイルの親フォルダを取得できません".to_string())?;
    let file_name = input
        .file_name()
        .ok_or_else(|| "ファイル名を取得できません".to_string())?;

    if overwrite {
        // 入力を読みながら同じパスへ書けないので、一時ファイルへ書いてから置き換える。
        // 拡張子は末尾に残す（FFmpeg が muxer を推測できるようにする）。
        // 例: video-14.mp4 → .video-14.35073.vmc-tmp.mp4
        let stem = input
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| file_name.to_string_lossy().into_owned());
        let ext = input.extension().and_then(|e| e.to_str()).unwrap_or("mp4");
        let temp = parent.join(format!(".{}.{}.vmc-tmp.{}", stem, std::process::id(), ext));
        Ok((temp.clone(), input.to_path_buf(), true))
    } else {
        let output_dir = parent.join("cleaned");
        fs::create_dir_all(&output_dir)
            .map_err(|error| format!("出力フォルダを作成できません: {error}"))?;
        let output = output_dir.join(file_name);
        Ok((output.clone(), output, false))
    }
}

fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    // 同一ボリュームなら rename で原子的に置き換え（macOS）
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            // 失敗時はコピー＋削除にフォールバック
            fs::copy(from, to).map_err(|error| {
                format!(
                    "上書きに失敗しました（rename: {rename_error}, copy: {error}）: {} → {}",
                    from.display(),
                    to.display()
                )
            })?;
            let _ = fs::remove_file(from);
            Ok(())
        }
    }
}

/// Preserve encoded media; audio inputs deliberately exclude cover art and data tracks.
fn clean_args(input: &Path, output: &Path) -> Vec<String> {
    let extension = input
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let audio = matches!(extension.as_str(), "mp3" | "m4a" | "wav" | "flac");
    let mut args: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-i"]
        .into_iter()
        .map(String::from)
        .collect();
    args.push(input.to_string_lossy().into_owned());
    let mapping: &[&str] = if audio {
        &["-map", "0:a"]
    } else {
        &["-map", "0:v", "-map", "0:a?", "-map", "0:s?"]
    };
    args.extend(mapping.iter().map(|value| value.to_string()));
    args.extend(
        [
            "-c",
            "copy",
            "-map_metadata",
            "-1",
            "-map_metadata:s",
            "-1",
            "-map_chapters",
            "-1",
            "-fflags",
            "+bitexact",
            "-metadata",
            "encoder=",
        ]
        .into_iter()
        .map(String::from),
    );
    if extension == "mp3" {
        // Keep Xing's duration/gapless playback information; suppress user ID3 tags.
        args.extend(
            ["-id3v2_version", "0", "-write_id3v1", "0"]
                .into_iter()
                .map(String::from),
        );
    }
    args.push(output.to_string_lossy().into_owned());
    args
}

#[tauri::command]
async fn clean_video(
    app: AppHandle,
    input_path: String,
    overwrite: bool,
) -> Result<CleanResult, String> {
    let input = PathBuf::from(&input_path);
    validate_input(&input)?;

    let (write_path, final_path, will_overwrite) = resolve_output_paths(&input, overwrite)?;

    let args = clean_args(&input, &write_path);

    let command = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|error| format!("FFmpeg sidecarを起動できません: {error}"))?
        .args(args);

    let result = command
        .output()
        .await
        .map_err(|error| format!("FFmpegの実行に失敗しました: {error}"))?;

    let stderr = String::from_utf8_lossy(&result.stderr).into_owned();

    if !result.status.success() {
        let _ = fs::remove_file(&write_path);
        return Err(if stderr.trim().is_empty() {
            "FFmpegが異常終了しました".to_string()
        } else {
            stderr
        });
    }

    if will_overwrite {
        if let Err(error) = replace_file(&write_path, &final_path) {
            let _ = fs::remove_file(&write_path);
            return Err(error);
        }
    }

    Ok(CleanResult {
        output_path: final_path.to_string_lossy().into_owned(),
        stderr,
        overwritten: will_overwrite,
    })
}

#[tauri::command]
async fn inspect_metadata(path: String) -> Result<MetadataReport, String> {
    let path = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || run_exiftool(&path))
        .await
        .map_err(|error| format!("メタデータ検査タスクが失敗しました: {error}"))?
}

/// ExifTool が PATH 上で実行できるか確認する（必須依存）。
#[tauri::command]
async fn check_exiftool() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let exiftool = resolve_exiftool().ok_or_else(exiftool_missing_message)?;
        let output = Command::new(exiftool)
            .arg("-ver")
            .output()
            .map_err(|error| {
                if error.kind() == ErrorKind::NotFound {
                    exiftool_missing_message()
                } else {
                    format!("exiftool の実行に失敗しました: {error}")
                }
            })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(if stderr.trim().is_empty() {
                "exiftool -ver が異常終了しました".to_string()
            } else {
                stderr.into_owned()
            });
        }

        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    })
    .await
    .map_err(|error| format!("exiftool 確認タスクが失敗しました: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            clean_video,
            inspect_metadata,
            check_exiftool
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_mapping_excludes_artwork_and_video_mapping_is_unchanged() {
        for ext in ["mp3", "M4A", "wav", "flac"] {
            let args = clean_args(Path::new(&format!("input.{ext}")), Path::new("output"));
            let maps: Vec<_> = args
                .windows(2)
                .filter(|pair| pair[0] == "-map")
                .map(|pair| pair[1].as_str())
                .collect();
            assert_eq!(maps, ["0:a"]);
            assert_eq!(
                args.iter().any(|value| value == "-id3v2_version"),
                ext == "mp3"
            );
        }
        let args = clean_args(Path::new("input.mov"), Path::new("output.mov"));
        let maps: Vec<_> = args
            .windows(2)
            .filter(|pair| pair[0] == "-map")
            .map(|pair| pair[1].as_str())
            .collect();
        assert_eq!(maps, ["0:v", "0:a?", "0:s?"]);
    }

    // Requires ffmpeg and ffprobe on PATH. Run explicitly for media integration validation.
    #[test]
    #[ignore = "requires local FFmpeg and ffprobe"]
    fn audio_remux_removes_tags_and_artwork_without_changing_samples() {
        fn execute(tool: &str, args: &[String]) -> Vec<u8> {
            let result = Command::new(tool)
                .args(args)
                .output()
                .expect("media tool must be installed");
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            result.stdout
        }
        fn strings(values: &[&str]) -> Vec<String> {
            values.iter().map(|value| value.to_string()).collect()
        }
        let dir = env::temp_dir().join(format!("vmc-audio-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        for (ext, codec) in [
            ("mp3", "libmp3lame"),
            ("m4a", "aac"),
            ("wav", "pcm_s16le"),
            ("flac", "flac"),
            ("m4a", "alac"),
        ] {
            let input = dir.join(format!("{codec}.{ext}"));
            let output = dir.join(format!("{codec}-clean.{ext}"));
            let mut args = strings(&[
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
            ]);
            if ext != "wav" {
                args.extend(strings(&[
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=red:s=32x32:r=1:d=1",
                    "-map",
                    "0:a",
                    "-map",
                    "1:v",
                    "-c:v",
                    "mjpeg",
                    "-disposition:v",
                    "attached_pic",
                ]));
            }
            args.extend(strings(&[
                "-c:a",
                codec,
                "-metadata",
                "title=AUDIO_TEST_TITLE",
                "-metadata",
                "artist=AUDIO_TEST_ARTIST",
                "-metadata",
                "comment=AUDIO_TEST_COMMENT",
            ]));
            args.push(input.to_string_lossy().into_owned());
            execute("ffmpeg", &args);
            let probe = |path: &Path| {
                let mut args = strings(&[
                    "-v",
                    "error",
                    "-show_entries",
                    "format_tags:stream=codec_type:stream_tags",
                    "-of",
                    "json",
                ]);
                args.push(path.to_string_lossy().into_owned());
                String::from_utf8(execute("ffprobe", &args)).unwrap()
            };
            let before = probe(&input);
            assert!(before.contains("AUDIO_TEST_TITLE"));
            assert_eq!(before.contains("\"video\""), ext != "wav");
            validate_input(&input).unwrap();
            execute("ffmpeg", &clean_args(&input, &output));
            let after = probe(&output);
            assert!(!after.contains("AUDIO_TEST_"), "{ext}: {after}");
            assert!(!after.contains("\"video\""), "artwork remains: {ext}");
            let samples = |path: &Path| {
                let mut args = strings(&["-v", "error", "-i"]);
                args.push(path.to_string_lossy().into_owned());
                args.extend(strings(&[
                    "-map",
                    "0:a:0",
                    "-c:a",
                    "pcm_s32le",
                    "-f",
                    "s32le",
                    "-",
                ]));
                execute("ffmpeg", &args)
            };
            assert_eq!(samples(&input), samples(&output), "audio changed: {codec}");
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
