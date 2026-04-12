#!/usr/bin/env python3
import os
import re
import shutil
import subprocess
import sys
from urllib.parse import urljoin
from urllib.request import Request, urlopen

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


def fetch_text(url, headers):
    request = Request(url, headers=headers)
    with urlopen(request) as response:
        return response.read().decode("utf-8", errors="replace")


def parse_stream_inf_attributes(line):
    attributes = {}
    for key, value in re.findall(r'([A-Z0-9\-]+)=("[^"]+"|[^,]+)', line):
        attributes[key] = value.strip('"')
    return attributes


def resolve_best_playlist_url(playlist_url, http_headers):
    try:
        playlist_text = fetch_text(playlist_url, http_headers)
    except Exception as error:
        print(f"Warning: failed to inspect playlist before download: {error}")
        return playlist_url

    if "#EXT-X-STREAM-INF" not in playlist_text:
        print(f"Using direct media playlist: {playlist_url}")
        return playlist_url

    variants = []
    lines = [line.strip() for line in playlist_text.splitlines()]

    for index, line in enumerate(lines):
        if not line.startswith("#EXT-X-STREAM-INF:"):
            continue

        attributes = parse_stream_inf_attributes(line)
        next_url = ""
        for candidate in lines[index + 1 :]:
          if candidate and not candidate.startswith("#"):
              next_url = urljoin(playlist_url, candidate)
              break

        if not next_url:
            continue

        resolution_text = attributes.get("RESOLUTION", "0x0")
        width, height = 0, 0
        if "x" in resolution_text:
            width_text, height_text = resolution_text.lower().split("x", 1)
            width = int(width_text) if width_text.isdigit() else 0
            height = int(height_text) if height_text.isdigit() else 0

        bandwidth = int(attributes.get("BANDWIDTH", "0"))
        variants.append(
            {
                "url": next_url,
                "resolution": resolution_text,
                "height": height,
                "bandwidth": bandwidth,
            }
        )

    if not variants:
        print(f"Warning: no variants parsed from playlist, using original URL: {playlist_url}")
        return playlist_url

    best_variant = max(variants, key=lambda item: (item["height"], item["bandwidth"]))
    print(
        "Resolved master playlist to media playlist:",
        best_variant["url"],
        f"(resolution={best_variant['resolution']}, bandwidth={best_variant['bandwidth']})",
    )
    return best_variant["url"]


def get_video_duration(playlist_url, ffmpeg_headers):
    ffprobe_path = find_executable("ffprobe")
    if not ffprobe_path:
        print("Warning: ffprobe was not found. Progress bar will not be shown.")
        return None

    cmd = [
        ffprobe_path,
        "-v",
        "error",
        "-headers",
        ffmpeg_headers,
        "-allowed_extensions",
        "ALL",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        playlist_url,
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return float(result.stdout.strip())
    except (subprocess.CalledProcessError, FileNotFoundError, ValueError):
        print("Warning: Could not determine video duration. Progress bar will not be shown.")
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

    http_headers = {
        "User-Agent": "Mozilla/5.0",
        "Cookie": cookie_string,
    }
    ffmpeg_headers = (
        f"User-Agent: {http_headers['User-Agent']}\r\n"
        f"Cookie: {http_headers['Cookie']}\r\n"
    )

    resolved_playlist_url = resolve_best_playlist_url(playlist_url, http_headers)
    total_duration = get_video_duration(resolved_playlist_url, ffmpeg_headers)
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
        "-allowed_extensions",
        "ALL",
        "-http_persistent",
        "0",
        "-headers",
        ffmpeg_headers,
        "-i",
        resolved_playlist_url,
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
        print("Resolved playlist used:", resolved_playlist_url)
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
