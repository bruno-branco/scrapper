import puppeteer, { Browser } from "puppeteer";
import { exec, spawn } from "child_process";
import { stderr, stdout } from "process";
import { error, time } from "console";
import { link } from "fs";
import readline from "readline";

const openChrome = `open -a "Google Chrome" --args --remote-debugging-port=9222 --no-first-run --no-default-browser-check`;
const getWsUrl = `curl http://localhost:9222/json/version`;
let scrappingLink = "";
let discipline = "";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function askQuestion(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      if (!question.trim()) {
        console.log("You must enter a value");
        return resolve(askQuestion(question));
      }
      resolve(answer);
    });
  });
}

const execPromise = (command) => {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) return reject(error);
      resolve(stdout.trim());
    });
  });
};

const waitForWsUrl = async (retries = 10, delay = 1000) => {
  for (let i = 0; i < retries; i++) {
    try {
      const data = await execPromise(getWsUrl);
      if (data) return JSON.parse(data);
    } catch (error) {
      console.log(`Retrying to get webSocket URL... (${i + 1} / ${retries})`);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("Failed to get the Web Socket Url after 10 attempts");
};

async function getLinksToScrap() {
  try {
    scrappingLink = await askQuestion("What do you want to scrap?");
    discipline = await askQuestion("What is the name of the discipline?");
    console.log("link: ", scrappingLink);
    console.log("Launching Chrome...");
    await execPromise(openChrome);
    console.log("Chrome launched successfuly!");

    console.log("Trying to fetch the WsUrl...");
    const wsUrl = await waitForWsUrl();
    console.log(wsUrl.webSocketDebuggerUrl);

    const browser = await puppeteer.connect({
      browserWSEndpoint: wsUrl.webSocketDebuggerUrl,
    });
    console.log("connected");

    const page = await browser.newPage();
    await page.goto(scrappingLink, {
      waitUntil: "networkidle2",
    });
    await page.waitForSelector("a.card", { timeout: 5000 });
    const currentLinks = await page.$$eval("a.card", (a) => {
      return a.map((item) => item.href);
    });
    await browser.disconnect();
    console.log("browser has disconnected");
    return currentLinks;
  } catch (error) {
    console.error(error);
  }
}

async function scrap() {
  try {
    async function getStreamList() {
      const links = await getLinksToScrap();
      const wsUrl = await waitForWsUrl();
      let streamPlayList = [];
      for (const link of links) {
        const browser = await puppeteer.connect({
          browserWSEndpoint: wsUrl.webSocketDebuggerUrl,
        });

        const page = await browser.newPage();

        const streamUrlPromise = new Promise((resolve) => {
          page.on("request", (request) => {
            if (request.url().endsWith("video.m3u8")) {
              console.log("Found streamUrl: ", request.url());
              resolve(request.url());
            }
          });
        });

        console.log("start listening");

        page.on("request", (request) => {
          try {
            if (request.url().endsWith("video.m3u8")) {
              console.log("Found streamUrl: ", request.url());
              streamPlayList.push(request.url());
            }
          } catch (error) {
            console.log(error);
          }
        });
        await page.goto(link, { waitUntil: "networkidle0" });

        await new Promise((resolve) => setTimeout(resolve, 2000));

        browser.disconnect();
        console.log("added to streamPlaylist: ", streamPlayList);
      }
      console.log("final streamPlaylist: ", streamPlayList);
      return streamPlayList;
    }
    const firstStreamList = await getStreamList();
    const streamList = [...new Set(firstStreamList)];

    console.log("returned stream list", firstStreamList);
    console.log("filtered list: ", streamList);

    console.log("starting list iteration");
    for (const [index, link] of streamList.entries()) {
      const outputName = `${discipline}-${index + 1}`;
      const appleScript = `
    tell application "Terminal"
      do script "cd Projects/true-scrapping/python && python3 script.py ${link} ${outputName}"
    end tell
  `;
      const pythonProcess = spawn("osascript", ["-e", appleScript]);

      pythonProcess.stdout.on("data", (data) => {
        console.log(`Python output: ${data}`);
      });

      pythonProcess.stderr.on("data", (data) => {
        console.error(`Python Error: ${data}`);
      });
      await new Promise((resolve) => pythonProcess.on("close", resolve));
      console.log("executed script for: ", link);
    }

    console.log("All python scripts are running.");

    rl.close();
  } catch (error) {
    console.error(error);
  }
}

scrap();

/* const browser = await puppeteer.launch();
const page = await browser.newPage();

await page.goto("https://annoying-case.vercel.app/");

/* await page.setViewport({ width: 1920, height: 1080 });

await page.locator('.course-card').click() */
