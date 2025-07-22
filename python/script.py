#!/usr/bin/env python3
import requests
import os
import sys

# Usage: python script.py <playlist_url> <output_name_without_ext>
# Example: python script.py "https://example.com/path/to/playlist.m3u8" myvideo

# === Configuration ===
HEADERS = {
    # Replace with your JWT or other auth if needed
    "Authorization": "Bearer eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoiYWNjZXNzIiwiZXhwIjoxNzM2ODEzNDc3LCJpYXQiOjE3MzY3OTE4NzcsImp0aSI6IjRlZDA1NTAxZDZiZjRmOTg5ODU1MWI3NmUwZTJmMzg0IiwidXNlcl9pZCI6MTE0fQ.nxfVs1aDvFC3x5KUzD41669i48d3bviCrXL6fR2l9pbuoNJiWFSbHuP6ufzG7XeZHU0nwEjSpkUqrkQozRzYhQ",
    "User-Agent": "Mozilla/5.0"
}
ORIGINAL_RES = "480p"   # the resolution string as it appears in the playlist
TARGET_RES = "1080p"   # desired resolution string to replace with
# ======================

def download_and_patch_playlist(url, playlist_file):
    resp = requests.get(url, headers=HEADERS)
    if resp.status_code != 200:
        print(f"Failed to download playlist: HTTP {resp.status_code}")
        sys.exit(1)
    text = resp.text
    # Replace occurrences of /480p/ with /1080p/
    # If the playlist uses another pattern (no slashes), adjust accordingly
    patched = text.replace(f"/{ORIGINAL_RES}/", f"/{TARGET_RES}/")
    # Optionally, also replace bare occurrences:
    # patched = patched.replace(ORIGINAL_RES, TARGET_RES)
    with open(playlist_file, "w", encoding="utf-8") as f:
        f.write(patched)
    print(f"Patched playlist saved as {playlist_file}")

def download_ts_files(playlist_file):
    ts_urls = []
    with open(playlist_file, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.endswith(".ts"):
                ts_urls.append(line)
    if not ts_urls:
        print("No .ts URLs found in the patched playlist.")
        return []
    os.makedirs("videos", exist_ok=True)
    for idx, ts_url in enumerate(ts_urls):
        ts_path = os.path.join("videos", f"segment_{idx}.ts")
        print(f"Downloading segment {idx}: {ts_url}")
        r = requests.get(ts_url, headers=HEADERS, stream=True)
        if r.status_code == 200:
            with open(ts_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=1024*1024):
                    if chunk:
                        f.write(chunk)
        else:
            print(f"  → Failed (HTTP {r.status_code}); segment skipped")
    print("Download attempts finished.")
    return len(ts_urls)

def merge_videos_with_ffmpeg(playlist_file, output_name, segment_count):
    # First try: let ffmpeg read the patched playlist directly
    cmd = (
        f"ffmpeg -protocol_whitelist file,http,https,tcp,tls,crypto "
        f"-i \"{playlist_file}\" -c copy \"{output_name}.mp4\""
    )
    print("Merging via ffmpeg with patched playlist...")
    ret = os.system(cmd)
    if ret == 0:
        print(f"Success: {output_name}.mp4 created")
        return
    print(f"ffmpeg merge failed (exit code {ret}). Falling back to concat segments.")
    # Fallback: concat downloaded .ts segments
    list_file = "file_list.txt"
    with open(list_file, "w", encoding="utf-8") as f:
        for i in range(segment_count):
            f.write(f"file 'videos/segment_{i}.ts'\n")
    cmd2 = f"ffmpeg -f concat -safe 0 -i \"{list_file}\" -c copy \"{output_name}.mp4\""
    print("Running fallback concat...")
    os.system(cmd2)
    print(f"Finished fallback. Check {output_name}.mp4")

def main():
    if len(sys.argv) != 3:
        print("Usage: python script.py <playlist_url> <output_name_without_ext>")
        sys.exit(1)
    playlist_url = sys.argv[1]
    output_name = sys.argv[2]
    playlist_file = f"playlist_{output_name}.m3u8"

    print(f"Processing playlist URL: {playlist_url}")
    download_and_patch_playlist(playlist_url, playlist_file)
    count = download_ts_files(playlist_file)
    if count:
        merge_videos_with_ffmpeg(playlist_file, output_name, count)
    else:
        print("No segments downloaded; skipping merge.")

if __name__ == "__main__":
    main()
