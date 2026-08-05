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

#[tauri::command]
async fn clean_video(app: AppHandle, input_path: String) -> Result<CleanResult, String> {
    let input = PathBuf::from(input_path);
    validate_input(&input)?;

    let parent = input
        .parent()
        .ok_or_else(|| "入力ファイルの親フォルダを取得できません".to_string())?;
    let output_dir = parent.join("cleaned");
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("出力フォルダを作成できません: {error}"))?;

    let file_name = input
        .file_name()
        .ok_or_else(|| "ファイル名を取得できません".to_string())?;
    let output = output_dir.join(file_name);

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
        output.to_string_lossy().into_owned(),
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
        return Err(if stderr.trim().is_empty() {
            "FFmpegが異常終了しました".to_string()
        } else {
            stderr
        });
    }

    Ok(CleanResult {
        output_path: output.to_string_lossy().into_owned(),
        stderr,
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
