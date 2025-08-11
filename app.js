import puppeteer from "puppeteer";
import readline from "readline";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const userDataDir = path.join(os.tmpdir(), "puppeteer-session");

function askQuestion(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      if (!answer.trim()) {
        console.log("You must enter a value.");
        return resolve(askQuestion(question));
      }
      resolve(answer);
    });
  });
}

/**
 * Executes the Python FFmpeg script, opening a new terminal window on macOS.
 * @param {string} playlistUrl
 * @param {string} outputName
 * @param {string} cookieString
 * @returns {Promise<void>}
 */
async function callPythonDownloader(playlistUrl, outputName, cookieString) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, "python", "script.py");
    const args = [scriptPath, playlistUrl, outputName, cookieString];

    console.log(`  🚀 Launching download in new window for: ${outputName}`);

    if (process.platform === "darwin") {
      // Logic for macOS
      const scriptDir = path.dirname(scriptPath);
      const scriptFile = path.basename(scriptPath);
      const shellQuote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
      const command = `cd ${shellQuote(scriptDir)} && python3 ${scriptFile} ${shellQuote(playlistUrl)} ${shellQuote(outputName)} ${shellQuote(cookieString)}`;
      const appleScript = `tell app "Terminal" to do script "${command.replace(/"/g, '\\"')}"`;
      const osascript = spawn("osascript", ["-e", appleScript]);

      osascript.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`AppleScript failed with code ${code}`));
      });
    }else {
  if (process.platform === "win32") {
    // Open new terminal window on Windows
    spawn("cmd.exe", ["/c", "start", "cmd", "/k", "py", ...args], {
      detached: true
    }).on("error", reject).on("spawn", resolve);
  } else {
    // Linux: run in current terminal
    const pythonProcess = spawn("python3", args, { stdio: "inherit" });
    pythonProcess.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Python script failed with code ${code}`));
    });
  }
} 
  });
}

async function scrap() {
  let browser;
  try {
    const disciplinePageUrl = await askQuestion(
      "What do you want to scrap? (Enter the URL of the main discipline page) ",
    );
    const discipline = await askQuestion(
      "What is the name of the discipline? ",
    );

    console.log("Launching browser...");
    browser = await puppeteer.launch({
      headless: false,
      userDataDir: userDataDir,
      args: [
        "--window-size=1440,900",
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    const playlistUrls = new Set();
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.url().endsWith("playlist.m3u8")) {
        playlistUrls.add(request.url());
      }
      request.continue();
    });

    console.log("Navigating to the discipline page...");
    await page.goto(disciplinePageUrl, { waitUntil: "networkidle2" });

    const loginButton = await page.$('button[data-testid="signin-submit"]');

    if (loginButton) {
      console.log(
        "Login required. Please log in manually in the browser window.",
      );
      console.log("Press Enter in this terminal after you have logged in...");
      await askQuestion("");
      await page.goto(disciplinePageUrl, { waitUntil: "networkidle2" });
    }

    console.log(
      "Page loaded. Waiting for all video playlists to be detected...",
    );
    await new Promise((r) => setTimeout(r, 5000));

    const collectedUrls = Array.from(playlistUrls);

    if (collectedUrls.length === 0) {
      throw new Error(
        "Could not find any 'playlist.m3u8' network requests. Please check the URL.",
      );
    }

    console.log(`Found ${collectedUrls.length} unique lessons to download.`);

    console.log("Extracting session cookies...");
    const cookies = await page.cookies();
    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const cookieFilePath = path.join(process.cwd(), "cookies.txt");

    await fs.writeFile(cookieFilePath, cookieString, "utf8");

    for (const [index, streamUrl] of collectedUrls.entries()) {
      const outputName = `${discipline}-${String(index + 1).padStart(2, "0")}`;
      console.log(
        `\n--- Processing Lesson ${index + 1}/${collectedUrls.length}: ${outputName} ---`,
      );

      try {
        await callPythonDownloader(streamUrl, outputName, cookieFilePath);
      } catch (error) {
        console.error(
          `  Skipping lesson ${outputName} due to an error during launch.`,
        );
      }
    }

    console.log("\nAll download tasks are complete.");
  } catch (error) {
    console.error("An unexpected error occurred in the main script:", error);
  } finally {
    if (browser) await browser.close();
    rl.close();
  }
}

scrap();
