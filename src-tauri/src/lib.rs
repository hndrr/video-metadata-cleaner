use serde::Serialize;
use std::{
    fs,
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

fn validate_input(path: &PathBuf) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!("入力ファイルが見つかりません: {}", path.display()));
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();

    if !matches!(extension.as_str(), "mp4" | "mov" | "m4v") {
        return Err(format!("未対応の形式です: .{extension}"));
    }

    Ok(())
}

fn run_exiftool(path: &Path) -> Result<MetadataReport, String> {
    if !path.is_file() {
        return Err(format!("ファイルが見つかりません: {}", path.display()));
    }

    let output = Command::new("exiftool")
        .args(["-G1", "-a", "-s", "-api", "largefilesupport=1"])
        .arg(path)
        .output()
        .map_err(|error| {
            if error.kind() == ErrorKind::NotFound {
                "exiftool が見つかりません。brew install exiftool を実行してください。".to_string()
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
            FLAGGED_KEYWORDS
                .iter()
                .any(|keyword| line.to_ascii_lowercase().contains(&keyword.to_ascii_lowercase()))
        })
        .map(str::to_string)
        .collect::<Vec<_>>();

    let line_count = stdout.lines().filter(|line| !line.trim().is_empty()).count();

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
        let ext = input
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("mp4");
        let temp = parent.join(format!(
            ".{}.{}.vmc-tmp.{}",
            stem,
            std::process::id(),
            ext
        ));
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

#[tauri::command]
async fn clean_video(
    app: AppHandle,
    input_path: String,
    overwrite: bool,
) -> Result<CleanResult, String> {
    let input = PathBuf::from(&input_path);
    validate_input(&input)?;

    let (write_path, final_path, will_overwrite) = resolve_output_paths(&input, overwrite)?;

    let args = vec![
        "-hide_banner".to_string(),
        "-nostdin".to_string(),
        "-y".to_string(),
        "-i".to_string(),
        input.to_string_lossy().into_owned(),
        "-map".to_string(),
        "0:v".to_string(),
        "-map".to_string(),
        "0:a?".to_string(),
        "-map".to_string(),
        "0:s?".to_string(),
        "-c".to_string(),
        "copy".to_string(),
        "-map_metadata".to_string(),
        "-1".to_string(),
        "-map_metadata:s".to_string(),
        "-1".to_string(),
        "-map_chapters".to_string(),
        "-1".to_string(),
        "-fflags".to_string(),
        "+bitexact".to_string(),
        "-metadata".to_string(),
        "encoder=".to_string(),
        write_path.to_string_lossy().into_owned(),
    ];

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![clean_video, inspect_metadata])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
