#!/usr/bin/env python3
import os
import sys
import re
import subprocess
from tqdm import tqdm # 1. Import tqdm for the progress bar

def get_video_duration(playlist_url, headers):
    """
    Uses ffprobe to get the total duration of the video in seconds.
    """
    # Command to get duration using ffprobe
    cmd = [
        'ffprobe',
        '-v', 'error',
        '-headers', headers,
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        playlist_url
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return float(result.stdout.strip())
    except (subprocess.CalledProcessError, FileNotFoundError):
        # If ffprobe fails or isn't found, we can't show a progress bar.
        print("⚠️ Warning: Could not determine video duration. Progress bar will not be shown.")
        return None
    except ValueError:
        print("⚠️ Warning: Could not parse video duration. Progress bar will not be shown.")
        return None


def download_video_with_ffmpeg(playlist_url, output_name, cookie_file_path):
    """
    Uses FFmpeg to download a video from an M3U8 master playlist,
    passing authentication cookies and showing a progress bar.
    """
    output_dir = "videos"
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, f"{output_name}.mp4")

    try:
        with open(cookie_file_path, "r", encoding="utf-8") as f:
            cookie_string = f.read().strip()
    except FileNotFoundError:
        print(f"❌ Error: The cookie file was not found at {cookie_file_path}")
        sys.exit(1)

    headers = (
        f'User-Agent: Mozilla/5.0\r\n'
        f'Cookie: {cookie_string}\r\n'
    )

    # 2. Get total duration for the progress bar
    total_duration = get_video_duration(playlist_url, headers)

    cmd = [
        'ffmpeg',
        '-y',
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
        '-http_persistent', '0',
        '-headers', headers,
        '-i', playlist_url,
        '-c', 'copy',
        # Add '-progress pipe:1' to send progress data to stdout
        '-progress', 'pipe:1',
        '-nostats', # Disables the default progress display on stderr
        output_path
    ]

    print(f"Executing FFmpeg to download: {output_name}.mp4")
    
    # 3. Use Popen to run ffmpeg and capture its stdout in real-time
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)

    # 4. Initialize tqdm progress bar
    pbar = tqdm(total=total_duration, unit='s', unit_scale=True, desc=output_name) if total_duration else None

    # Regex to find the time in the progress output
    time_pattern = re.compile(r"out_time_ms=(\d+)")
    last_time_ms = 0

    # Read stdout line-by-line to update the progress bar
    for line in process.stdout:
        match = time_pattern.search(line)
        if match and pbar:
            current_time_ms = int(match.group(1))
            # Update the progress bar with the difference since the last update
            pbar.update((current_time_ms - last_time_ms) / 1_000_000)
            last_time_ms = current_time_ms

    # Wait for the process to finish and get the return code
    process.wait()

    if pbar:
        # Ensure the progress bar completes to 100% if the download was successful
        if process.returncode == 0 and pbar.n < pbar.total:
             pbar.update(pbar.total - pbar.n)
        pbar.close()

    if process.returncode == 0:
        print(f"\n✅ Successfully downloaded and saved to {output_path}")
    else:
        print(f"\n❌ FFmpeg failed with exit code {process.returncode} for {output_name}.mp4")
        print("\n--- FFmpeg Error Output (stderr) ---")
        # Read any remaining error output
        stderr_output = process.stderr.read()
        print(stderr_output)
        print("\n------------------------------------")
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
