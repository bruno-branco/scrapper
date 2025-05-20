import requests
import os
import sys

# Replace with your JWT token if authentication is needed
HEADERS = {
    "Authorization": "Bearer eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoiYWNjZXNzIiwiZXhwIjoxNzM2ODEzNDc3LCJpYXQiOjE3MzY3OTE4NzcsImp0aSI6IjRlZDA1NTAxZDZiZjRmOTg5ODU1MWI3NmUwZTJmMzg0IiwidXNlcl9pZCI6MTE0fQ.nxfVs1aDvFC3x5KUzD41669i48d3bviCrXL6fR2l9pbuoNJiWFSbHuP6ufzG7XeZHU0nwEjSpkUqrkQozRzYhQ",
    "User-Agent": "Mozilla/5.0"
}

# Replace this URL with the .m3u8 playlist URL or direct video URL
VIDEO_URL =sys.argv[1]
OUTPUT_FILE =sys.argv[2]
PLAYLIST_FILE = f"playlist_{OUTPUT_FILE}.m3u8"


print(f"PROCESSING {VIDEO_URL} with output {OUTPUT_FILE}")


def download_m3u8(url):
    response = requests.get(url, headers=HEADERS)
    if response.status_code == 200:
        with open(PLAYLIST_FILE, "wb") as f:
            f.write(response.content)
        print(f"Playlist downloaded as {PLAYLIST_FILE}.")
    else:
        print("Failed to download playlist.")

def download_ts_files():
    with open(PLAYLIST_FILE, "r") as file:
        lines = file.readlines()
    
    ts_files = [line.strip() for line in lines if line.endswith('.ts')]
    
    os.makedirs("videos", exist_ok=True)

    for idx, ts_url in enumerate(ts_files):
        ts_file = f"videos/segment_{idx}.ts"
        print(f"Downloading {ts_url}...")
        ts_response = requests.get(ts_url, headers=HEADERS)
        with open(ts_file, "wb") as f:
            f.write(ts_response.content)
    print("All segments downloaded.")

def merge_videos():
    with open("file_list.txt", "w") as f:
        for i in range(len(os.listdir("videos"))):
            f.write(f"file 'videos/segment_{i}.ts'\n")
    
    os.system(f"ffmpeg -protocol_whitelist file,http,https,tcp,tls,crypto -i {PLAYLIST_FILE} -c copy videos/{OUTPUT_FILE}.mp4")
    print(f"Video merged into {OUTPUT_FILE}.mp4")

# Run the steps
download_m3u8(VIDEO_URL)
download_ts_files()
merge_videos()
