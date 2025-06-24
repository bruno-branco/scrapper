import puppeteer from "puppeteer";
import { spawn } from "child_process";
import readline from "readline";
import path from "path";
import os from "os";

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
      // Windows: Use cmd /c start to open new window with command
      command = "cmd";
      args = [
        "/c",
        `start "Download ${outputName}" cmd /k "cd python && python script.py ${streamUrl} ${outputName} && pause && exit"`
      ];
    } else {
      // macOS: Use AppleScript with Terminal
      const appleScript = `
        tell application "Terminal"
          do script "cd Projects/true-scrapping/python && python3 script.py ${streamUrl} ${outputName}"
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

    for (const [index, link] of links.entries()) {
      console.log(`Processing link ${index + 1}/${links.length}`);

      const newPage = await browser.newPage();
      await newPage.setRequestInterception(true);

      newPage.on("request", (request) => {
        if (request.url().endsWith("video.m3u8")) {
          console.log("Found streamUrl: ", request.url());
          streamPlayList.push(request.url());
        }
        request.continue();
      });

      await newPage.goto(link, { waitUntil: "networkidle0" });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await newPage.close();
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
