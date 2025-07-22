import puppeteer from "puppeteer";
import { spawn } from "child_process";
import readline from "readline";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

// Resolve __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let scrappingLink = "";
let discipline = "";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const userDataDir = path.join(os.tmpdir(), "puppeteer-session");

function askQuestion(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      if (!answer.trim()) {
        console.log("You must enter a value");
        return resolve(askQuestion(question));
      }
      resolve(answer);
    });
  });
}

async function executeDownloadScript(streamUrl, outputName) {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32";
    let command, args;

    if (isWindows) {
      // Compute absolute path to the python folder alongside this script
      const pythonDir = path.join(__dirname, "python");
      // Wrap URLs and names in quotes to avoid parsing issues
      const quotedUrl = `"${streamUrl}"`;
      const quotedOutput = `"${outputName}"`;
      // Windows: Use cmd /c start to open new window and run commands
      // cd /d ensures drive letter is changed if needed
      const cmdString = `cd /d "${pythonDir}" && python script.py ${quotedUrl} ${quotedOutput} && pause && exit`;
      command = "cmd";
      args = ["/c", `start "Download ${outputName}" cmd /k "${cmdString}"`];
    } else {
      // macOS or Linux: adjust if needed, but focusing on Windows per request
      const pythonDir = path.join(__dirname, "python");
      const quotedUrl = `"${streamUrl}"`;
      const quotedOutput = `"${outputName}"`;
      // For macOS: open Terminal and run in that directory
      const appleScript = `
        tell application "Terminal"
          do script "cd '${pythonDir.replace(/'/g, "'\\''")}' && python3 script.py ${quotedUrl} ${quotedOutput}"
        end tell
      `;
      command = "osascript";
      args = ["-e", appleScript];
    }

    const pythonProcess = spawn(command, args, {
      shell: true,
      detached: true,
      stdio: 'ignore'
    });

    pythonProcess.on("error", (error) => {
      console.error(`Failed to start process for ${outputName}:`, error);
      reject(error);
    });

    setTimeout(() => {
      console.log(`Started download process for: ${outputName}`);
      resolve();
    }, 500);
  });
}

async function scrap() {
  try {
    scrappingLink = await askQuestion("What do you want to scrap?");
    discipline = await askQuestion("What is the name of the discipline?");

    console.log("link: ", scrappingLink);
    console.log("Launching browser...");

    const browser = await puppeteer.launch({
      headless: false,
      userDataDir: userDataDir,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    const page = await browser.newPage();
    await page.goto(scrappingLink, { waitUntil: "networkidle2" });

    const isLoginPage = (await page.$('input[type="password"]')) !== null;
    if (isLoginPage) {
      console.log(
        "Login required. Please log in manually in the browser window.",
      );
      console.log("Press Enter after you've logged in...");
      await askQuestion("");
      await page.goto(scrappingLink, { waitUntil: "networkidle2" });
    }

    await page.waitForSelector("a.card", { timeout: 5000 });
    const links = await page.$$eval("a.card", (a) => {
      return a.map((item) => item.href);
    });

    console.log("Found links:", links.length);

    let streamPlayList = [];

    // Retry parameters
    const maxRetries = 3;
    const retryDelayMs = 2000; // 2 seconds between retries
    const navigationTimeout = 45000; // 45 seconds timeout for navigation

    for (const [index, link] of links.entries()) {
      console.log(`Processing link ${index + 1}/${links.length}`);

      let attempt = 0;
      let success = false;

      while (attempt < maxRetries && !success) {
        const attemptNum = attempt + 1;
        console.log(`  Attempt ${attemptNum} to load ${link}`);
        const newPage = await browser.newPage();
        try {
          await newPage.setRequestInterception(true);
          newPage.on("request", (request) => {
            if (request.url().endsWith("video.m3u8")) {
              console.log("Found streamUrl: ", request.url());
              streamPlayList.push(request.url());
            }
            request.continue();
          });

          // Set page-specific timeout
          newPage.setDefaultNavigationTimeout(navigationTimeout);

          // Use a lighter waitUntil; after DOM loaded, we wait a bit to catch requests
          await newPage.goto(link, { waitUntil: "domcontentloaded", timeout: navigationTimeout });

          // Wait briefly to allow any lazy requests for .m3u8 to fire
          await new Promise((r) => setTimeout(r, 2000));

          success = true;
          console.log(`  Success loading link on attempt ${attemptNum}`);
          await newPage.close();
        } catch (error) {
          // Check if TimeoutError
          const isTimeout = error && (error.name === 'TimeoutError' || error.message.includes('Navigation timeout'));
          console.warn(`  Attempt ${attemptNum} failed${isTimeout ? ' (timeout)' : ''}: ${error.message}`);
          try { await newPage.close(); } catch (_) {}
          attempt++;
          if (attempt < maxRetries) {
            console.log(`  Retrying after ${retryDelayMs}ms...`);
            await new Promise((r) => setTimeout(r, retryDelayMs));
          }
        }
      }

      if (!success) {
        console.error(`  Failed to load ${link} after ${maxRetries} attempts; skipping.`);
      }
    }

    await browser.close();

    const uniqueStreams = [...new Set(streamPlayList)];
    console.log(`Found ${uniqueStreams.length} unique streams`);

    for (const [index, streamUrl] of uniqueStreams.entries()) {
      const outputName = `${discipline}-${index + 1}`;
      console.log(
        `Starting download ${index + 1}/${uniqueStreams.length}: ${outputName}`,
      );

      try {
        await executeDownloadScript(streamUrl, outputName);
      } catch (error) {
        console.error(`Failed to process ${outputName}:`, error.message);
      }
    }

    console.log("All downloads completed.");
    rl.close();
  } catch (error) {
    console.error("Error:", error);
    rl.close();
  }
}

scrap();
