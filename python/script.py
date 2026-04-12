#!/usr/bin/env python3
import os
import re
import shutil
import subprocess
import sys

from tqdm import tqdm


def find_executable(name):
    found = shutil.which(name)
    if found:
        return found

    executable_names = [name]
    if os.name == "nt" and not name.lower().endswith(".exe"):
        executable_names.append(f"{name}.exe")

    search_dirs = [
        os.getcwd(),
        os.path.dirname(__file__),
        os.path.dirname(os.path.dirname(__file__)),
    ]

    for search_dir in search_dirs:
        for executable_name in executable_names:
            candidate = os.path.join(search_dir, executable_name)
            if os.path.isfile(candidate):
                return candidate

    return None


def get_video_duration(playlist_url, headers):
    ffprobe_path = find_executable("ffprobe")
    if not ffprobe_path:
        print("Warning: ffprobe was not found. Progress bar will not be shown.")
        return None

    cmd = [
        ffprobe_path,
        "-v",
        "error",
        "-headers",
        headers,
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        playlist_url,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return float(result.stdout.strip())
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("Warning: Could not determine video duration. Progress bar will not be shown.")
        return None
    except ValueError:
        print("Warning: Could not parse video duration. Progress bar will not be shown.")
        return None


def download_video_with_ffmpeg(playlist_url, output_name, cookie_file_path):
    output_dir = "videos"
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, f"{output_name}.mp4")

    try:
        with open(cookie_file_path, "r", encoding="utf-8") as file:
            cookie_string = file.read().strip()
    except FileNotFoundError:
        print(f"Error: The cookie file was not found at {cookie_file_path}")
        sys.exit(1)

    headers = (
        "User-Agent: Mozilla/5.0\r\n"
        f"Cookie: {cookie_string}\r\n"
    )

    total_duration = get_video_duration(playlist_url, headers)
    ffmpeg_path = find_executable("ffmpeg")

    if not ffmpeg_path:
        print("Error: ffmpeg was not found.")
        print("Install FFmpeg and make sure ffmpeg.exe is in PATH, or put ffmpeg.exe in the repo folder.")
        print(f"Current PATH: {os.environ.get('PATH', '')}")
        sys.exit(1)

    cmd = [
        ffmpeg_path,
        "-y",
        "-protocol_whitelist",
        "file,http,https,tcp,tls,crypto",
        "-http_persistent",
        "0",
        "-headers",
        headers,
        "-i",
        playlist_url,
        "-c",
        "copy",
        "-progress",
        "pipe:1",
        "-nostats",
        output_path,
    ]

    print(f"Executing FFmpeg to download: {output_name}.mp4")
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        universal_newlines=True,
    )

    pbar = tqdm(total=total_duration, unit="s", unit_scale=True, desc=output_name) if total_duration else None
    time_pattern = re.compile(r"out_time_ms=(\d+)")
    last_time_ms = 0
    full_output = []

    for line in process.stdout:  # type: ignore
        full_output.append(line)
        match = time_pattern.search(line)
        if match and pbar:
            current_time_ms = int(match.group(1))
            pbar.update((current_time_ms - last_time_ms) / 1_000_000)
            last_time_ms = current_time_ms

    process.wait()

    if pbar:
        if process.returncode == 0 and pbar.n < pbar.total:
            pbar.update(pbar.total - pbar.n)
        pbar.close()

    if process.returncode == 0:
        print(f"\nSuccessfully downloaded and saved to {output_path}")
    else:
        print(f"\nFFmpeg failed with exit code {process.returncode} for {output_name}.mp4")
        print("\n--- FFmpeg Full Output ---")
        print("".join(full_output))
        print("\n--------------------------")
        print("Please ensure FFmpeg is installed and accessible in your system's PATH.")
        sys.exit(1)


def main():
    if len(sys.argv) != 4:
        print("Usage: python script.py <playlist_url> <output_name> <cookie_file_path>")
        sys.exit(1)

    playlist_url = sys.argv[1]
    output_name = sys.argv[2]
    cookie_file_path = sys.argv[3]

    download_video_with_ffmpeg(playlist_url, output_name, cookie_file_path)


if __name__ == "__main__":
    main()
