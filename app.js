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
const lessonCardSelector = ".card-topic.v-card--link";
const playlistFileName = "playlist.m3u8";
function logDebug(scope, message, details) {
  return;
}

function logWarn(scope, message, details) {
  return;
}

function logError(scope, message, details) {
  return;
}

function shouldLogRequest(url = "") {
  return false;
}

function askQuestion(question, { allowEmpty = false } = {}) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      if (!allowEmpty && !answer.trim()) {
        console.log("You must enter a value.");
        return resolve(askQuestion(question, { allowEmpty }));
      }
      resolve(answer);
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlaylistUrl(url) {
  try {
    return new URL(url).pathname.endsWith(playlistFileName);
  } catch {
    return url.includes(playlistFileName);
  }
}

function isPreferredPlaylistUrl(url) {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.pathname.endsWith(playlistFileName) && !parsedUrl.search;
  } catch {
    return url.endsWith(playlistFileName);
  }
}

function buildPlaylistKey(url) {
  try {
    const parsedUrl = new URL(url);
    return `${parsedUrl.origin}${parsedUrl.pathname}`;
  } catch {
    return String(url).replace(/\?.*$/, "");
  }
}

function collectUniquePlaylistUrls(playlistUrls) {
  const uniquePlaylists = new Map();

  for (const url of playlistUrls) {
    const key = buildPlaylistKey(url);
    const currentValue = uniquePlaylists.get(key);

    if (!currentValue || (!isPreferredPlaylistUrl(currentValue) && isPreferredPlaylistUrl(url))) {
      uniquePlaylists.set(key, url);
    }
  }

  return Array.from(uniquePlaylists.values());
}

function sanitizeFileName(value) {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
}

function buildOutputName(discipline, index, lessonTitle = "") {
  const lessonNumber = String(index + 1).padStart(2, "0");
  const baseName = lessonTitle
    ? `${discipline}-${lessonNumber}-${lessonTitle}`
    : `${discipline}-${lessonNumber}`;
  const cleanName = sanitizeFileName(baseName);

  return cleanName.length > 180
    ? cleanName.slice(0, 180).replace(/[. -]+$/g, "")
    : cleanName;
}

async function waitForPageToSettle(page) {
  logDebug("page", "Waiting for page to settle", { url: page.url() });
  await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
  await wait(1000);
  logDebug("page", "Page settled", { url: page.url() });
}

async function navigateToCoursePage(page, coursePageUrl) {
  logDebug("nav", "Navigating to course page", { coursePageUrl });
  await page.goto(coursePageUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  logDebug("nav", "Navigation completed", { currentUrl: page.url() });
  await waitForPageToSettle(page);
}

async function extractLessonCards(page) {
  const lessons = await page.$$eval(lessonCardSelector, (cards) => {
    const normalizeText = (value) => value?.replace(/\s+/g, " ").trim() || "";
    const seen = new Set();

    return cards
      .map((card, index) => {
        const wrapper = card.closest("[id]");
        const title =
          normalizeText(card.querySelector(".card-topic__topic-title h3")?.textContent) ||
          normalizeText(card.querySelector("h3")?.textContent) ||
          normalizeText(card.textContent);
        const subtitle = normalizeText(
          card.querySelector(".card-topic__topic-subtitle")?.textContent,
        );
        const id = wrapper?.id || "";
        const key = id || title || `card-${index}`;

        return { id, title, subtitle, index, key };
      })
      .filter((lesson) => {
        if (!lesson.title || seen.has(lesson.key)) return false;
        seen.add(lesson.key);
        return true;
      });
  });
  logDebug("lessons", "Extracted lesson cards from current DOM snapshot", {
    count: lessons.length,
    titles: lessons.slice(0, 10).map((lesson) => lesson.title),
  });
  return lessons;
}

async function revealMoreLessonCards(page) {
  const moved = await page.evaluate(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const isUsable = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const disabled =
        element.disabled ||
        element.getAttribute("aria-disabled") === "true" ||
        element.classList.contains("swiper-button-disabled") ||
        element.classList.contains("v-btn--disabled");

      return (
        !disabled &&
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.pointerEvents !== "none"
      );
    };

    const controls = Array.from(
      document.querySelectorAll(
        ".swiper-button-next, .v-slide-group__next, .v-window__next button",
      ),
    ).filter(isUsable);

    let moved = false;
    for (const control of controls) {
      control.scrollIntoView({ block: "center", inline: "center" });
      control.click();
      moved = true;
      await wait(250);
    }

    const beforeY = window.scrollY;
    window.scrollBy(0, Math.max(500, Math.floor(window.innerHeight * 0.8)));
    await wait(250);

    return moved || window.scrollY !== beforeY;
  });
  logDebug("lessons", "Attempted to reveal more lesson cards", { moved });
  return moved;
}

async function discoverCourseLessons(page) {
  const lessonsByKey = new Map();
  let stableRounds = 0;

  console.log(`Looking for lesson cards with selector: ${lessonCardSelector}`);
  await page.waitForSelector(lessonCardSelector, { timeout: 15000 }).catch(() => {});

  for (let round = 0; round < 40; round += 1) {
    const beforeCount = lessonsByKey.size;
    const lessons = await extractLessonCards(page);

    for (const lesson of lessons) {
      if (!lessonsByKey.has(lesson.key)) {
        lessonsByKey.set(lesson.key, {
          ...lesson,
          discoveryIndex: lessonsByKey.size,
        });
      }
    }

    const moved = await revealMoreLessonCards(page);
    stableRounds = lessonsByKey.size === beforeCount ? stableRounds + 1 : 0;
    logDebug("lessons", "Discovery round completed", {
      round: round + 1,
      beforeCount,
      afterCount: lessonsByKey.size,
      stableRounds,
      moved,
    });

    if (!moved && stableRounds >= 2) break;
  }

  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

  const discoveredLessons = Array.from(lessonsByKey.values()).sort(
    (a, b) => a.discoveryIndex - b.discoveryIndex,
  );
  logDebug("lessons", "Finished lesson discovery", {
    total: discoveredLessons.length,
    titles: discoveredLessons.map((lesson) => lesson.title),
  });
  return discoveredLessons;
}

async function clickLessonCard(page, lesson) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    logDebug("lesson-open", "Trying to click lesson card", {
      attempt: attempt + 1,
      lessonTitle: lesson.title,
      lessonId: lesson.id,
    });
    const clicked = await page.evaluate(
      async ({ id, title, lessonCardSelector }) => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const normalizeText = (value) => value?.replace(/\s+/g, " ").trim() || "";
        const findCard = () => {
          if (id) {
            const wrapper = Array.from(document.querySelectorAll("[id]")).find(
              (element) => element.id === id,
            );
            const byId = wrapper?.matches(lessonCardSelector)
              ? wrapper
              : wrapper?.querySelector(lessonCardSelector);
            if (byId) return byId;
          }

          return Array.from(document.querySelectorAll(lessonCardSelector)).find((card) => {
            const cardTitle =
              normalizeText(card.querySelector(".card-topic__topic-title h3")?.textContent) ||
              normalizeText(card.querySelector("h3")?.textContent);
            return cardTitle === title;
          });
        };

        const card = findCard();
        if (!card) return false;

        card.scrollIntoView({ block: "center", inline: "center" });
        await wait(250);
        card.click();
        return true;
      },
      { id: lesson.id, title: lesson.title, lessonCardSelector },
    );

    if (clicked) {
      logDebug("lesson-open", "Lesson card clicked", {
        lessonTitle: lesson.title,
        lessonId: lesson.id,
      });
      return;
    }

    const moved = await revealMoreLessonCards(page);
    logWarn("lesson-open", "Lesson card not found in current view", {
      lessonTitle: lesson.title,
      attempt: attempt + 1,
      moved,
    });
    if (!moved && attempt > 2) break;
  }

  throw new Error(`Could not find card for lesson: ${lesson.title}`);
}

async function waitForNewPlaylistUrl(playlistUrls, seenUrls, timeoutMs = 45000) {
  const startedAt = Date.now();
  const fallbackDelayMs = 2000;
  console.log("Waiting for a new playlist request...");

  while (Date.now() - startedAt < timeoutMs) {
    const freshUrls = Array.from(playlistUrls).filter((url) => !seenUrls.has(url));
    const preferredUrl = freshUrls.find(isPreferredPlaylistUrl);

    if (preferredUrl) {
      console.log(`Playlist found: ${preferredUrl}`);
      return preferredUrl;
    }

    if (freshUrls.length > 0 && Date.now() - startedAt >= fallbackDelayMs) {
      console.log(`Playlist found: ${freshUrls[0]}`);
      return freshUrls[0];
    }
    await wait(250);
  }

  console.log("No new playlist was found for this lesson.");
  throw new Error(`Timed out waiting for a ${playlistFileName} request`);
}

async function writeCookiesFile(page, playlistUrls = []) {
  const playlistUrlList = Array.isArray(playlistUrls) ? playlistUrls : [playlistUrls];
  const cookieUrls = Array.from(new Set([page.url(), ...playlistUrlList].filter(Boolean)));
  const cookies = await page.cookies(...cookieUrls);
  const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const cookieFilePath = path.join(process.cwd(), "cookies.txt");

  await fs.writeFile(cookieFilePath, cookieString, "utf8");
  logDebug("cookies", "Cookies file written", {
    cookieFilePath,
    cookieCount: cookies.length,
    cookieUrls,
  });
  return cookieFilePath;
}

async function launchDownloadTasks(downloads, cookieFilePath) {
  console.log(`\nStarting ${downloads.length} Python download task(s)...`);
  logDebug("download", "Launching Python download tasks", {
    cookieFilePath,
    downloads: downloads.map(({ outputName, streamUrl }) => ({ outputName, streamUrl })),
  });
  const results = await Promise.allSettled(
    downloads.map(({ streamUrl, outputName }) =>
      callPythonDownloader(streamUrl, outputName, cookieFilePath),
    ),
  );
  const failedLaunches = results.filter((result) => result.status === "rejected");

  if (failedLaunches.length > 0) {
    console.error(`Failed to launch ${failedLaunches.length} download task(s).`);
    failedLaunches.forEach((result) => {
      console.error(`  ${result.reason?.message || result.reason}`);
    });
  }
}

async function triggerVideoPlayback(page) {
  logDebug("playback", "Attempting to trigger video playback", {
    url: page.url(),
  });
  await page
    .evaluate(() => {
      const normalizeText = (value) =>
        value?.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() || "";
      const candidates = Array.from(
        document.querySelectorAll(
          "button, [role='button'], .vjs-big-play-button, .plyr__control--overlaid",
        ),
      );
      const playButton = candidates.find((element) => {
        const label = normalizeText(
          element.getAttribute("aria-label") ||
            element.getAttribute("title") ||
            element.textContent,
        );
        return label.includes("play") || label.includes("reproduzir");
      });

      if (playButton) {
        playButton.click();
        return;
      }

      const video = document.querySelector("video");
      if (video && video.paused) {
        video.play().catch(() => {});
      }
    })
    .catch(() => {});
  logDebug("playback", "Playback trigger attempt finished", {
    url: page.url(),
  });
}

/**
 * Executes the Python FFmpeg script, opening a new terminal window on macOS.
 * @param {string} playlistUrl
 * @param {string} outputName
 * @param {string} cookieFilePath
 * @returns {Promise<void>}
 */
async function callPythonDownloader(playlistUrl, outputName, cookieFilePath) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, "python", "script.py");
    const args = [scriptPath, playlistUrl, outputName, cookieFilePath];
    logDebug("download", "Preparing downloader process", {
      platform: process.platform,
      scriptPath,
      playlistUrl,
      outputName,
      cookieFilePath,
    });

    console.log(`  🚀 Launching download in new window for: ${outputName}`);

    if (process.platform === "darwin") {
      // Logic for macOS
      const scriptDir = path.dirname(scriptPath);
      const scriptFile = path.basename(scriptPath);
      const shellQuote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
      const command = `cd ${shellQuote(scriptDir)} && python3 ${scriptFile} ${shellQuote(playlistUrl)} ${shellQuote(outputName)} ${shellQuote(cookieFilePath)}`;
      const appleScript = `tell app "Terminal" to do script "${command.replace(/"/g, '\\"')}"`;
      const osascript = spawn("osascript", ["-e", appleScript]);

      osascript.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`AppleScript failed with code ${code}`));
      });
    } else if (process.platform === "win32") {
      const child = spawn(
        "cmd.exe",
        [
          "/d",
          "/c",
          "start",
          '""',
          "/D",
          __dirname,
          "cmd.exe",
          "/K",
          "py",
          ...args,
        ],
        {
        cwd: __dirname,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
        },
      );

      child.on("error", reject);
      child.on("spawn", () => {
        child.unref();
        resolve();
      });
    } else {
      // Linux: run in current terminal
      const pythonProcess = spawn("python3", args, { stdio: "inherit" });
      pythonProcess.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Python script failed with code ${code}`));
      });
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
    logDebug("browser", "Browser page created", {
      viewport: { width: 1440, height: 900 },
      userDataDir,
    });

    const playlistUrls = new Set();
    const observedRequests = [];
    page.on("request", (request) => {
      const url = request.url();
      const entry = {
        url,
        method: request.method(),
        resourceType: request.resourceType(),
        timestamp: new Date().toISOString(),
      };

      if (shouldLogRequest(url)) {
        observedRequests.push(entry);
        if (observedRequests.length > 100) observedRequests.shift();
        logDebug("request", "Observed potentially relevant request", entry);
      }

      if (isPlaylistUrl(url)) {
        playlistUrls.add(url);
        logDebug("request", "Captured playlist request", {
          url,
          totalCaptured: playlistUrls.size,
        });
      }
    });
    page.on("response", (response) => {
      const url = response.url();
      if (shouldLogRequest(url)) {
        logDebug("response", "Observed potentially relevant response", {
          url,
          status: response.status(),
          ok: response.ok(),
        });
      }
    });
    page.on("requestfailed", (request) => {
      const url = request.url();
      if (shouldLogRequest(url)) {
        logWarn("request", "Relevant request failed", {
          url,
          method: request.method(),
          resourceType: request.resourceType(),
          failure: request.failure(),
        });
      }
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        logDebug("nav", "Main frame navigated", { url: frame.url() });
      }
    });
    page.on("console", (msg) => {
      logDebug("page-console", "Browser console message", {
        type: msg.type(),
        text: msg.text(),
      });
    });

    console.log("Navigating to the discipline page...");
    await navigateToCoursePage(page, disciplinePageUrl);

    const loginButton = await page.$('button[data-testid="signin-submit"]');

    if (loginButton) {
      console.log(
        "Login required. Please log in manually in the browser window.",
      );
      console.log("Press Enter in this terminal after you have logged in...");
      await askQuestion("", { allowEmpty: true });
      await navigateToCoursePage(page, disciplinePageUrl);
    }

    console.log("Looking for lesson cards on the course page...");
    const lessons = await discoverCourseLessons(page);

    if (lessons.length > 0) {
      console.log(`Found ${lessons.length} lesson cards.`);
      lessons.forEach((lesson, index) => {
        console.log(`  ${String(index + 1).padStart(2, "0")}. ${lesson.title}`);
      });
      logDebug("lessons", "Lesson list ready for processing", {
        total: lessons.length,
        lessons: lessons.map(({ id, title, subtitle }) => ({ id, title, subtitle })),
      });

      const downloadedPlaylistKeys = new Set();
      const downloads = [];

      for (const [index, lesson] of lessons.entries()) {
        const outputName = buildOutputName(discipline, index, lesson.title);
        console.log(
          `\n--- Collecting Lesson ${index + 1}/${lessons.length}: ${outputName} ---`,
        );

        try {
          await navigateToCoursePage(page, disciplinePageUrl);
          const seenUrls = new Set(playlistUrls);
          logDebug("lesson-loop", "Starting lesson collection", {
            lessonNumber: index + 1,
            lessonTitle: lesson.title,
            outputName,
            seenPlaylistCount: seenUrls.size,
          });

          console.log(`Opening lesson: ${lesson.title}`);
          await clickLessonCard(page, lesson);
          await wait(3000);
          logDebug("lesson-loop", "Waited after opening lesson", {
            lessonTitle: lesson.title,
            currentUrl: page.url(),
          });
          await triggerVideoPlayback(page);

          const streamUrl = await waitForNewPlaylistUrl(playlistUrls, seenUrls);

          const playlistKey = buildPlaylistKey(streamUrl);

          if (downloadedPlaylistKeys.has(playlistKey)) {
            console.log("  Skipping duplicate playlist URL.");
            logWarn("lesson-loop", "Duplicate playlist URL skipped", {
              lessonTitle: lesson.title,
              streamUrl,
            });
            continue;
          }

          downloadedPlaylistKeys.add(playlistKey);
          downloads.push({ streamUrl, outputName, title: lesson.title });
          console.log(`  Captured playlist: ${streamUrl}`);
          logDebug("lesson-loop", "Lesson collection completed", {
            lessonTitle: lesson.title,
            outputName,
            streamUrl,
          });
        } catch (error) {
          logError("lesson-loop", "Lesson collection failed", {
            lessonTitle: lesson.title,
            outputName,
            currentUrl: page.url(),
            capturedPlaylists: Array.from(playlistUrls),
            recentObservedRequests: observedRequests.slice(-20),
            error: error.message || String(error),
          });
          console.error(
            `  Skipping lesson ${outputName}: ${error.message || error}`,
          );
        }
      }

      if (downloads.length === 0) {
        throw new Error(`No ${playlistFileName} requests were captured from the lesson cards.`);
      }

      console.log(`\nCollected ${downloads.length} playlist URL(s).`);
      const cookieFilePath = await writeCookiesFile(
        page,
        downloads.map((download) => download.streamUrl),
      );
      await launchDownloadTasks(downloads, cookieFilePath);
    } else {
      console.log(
        "No lesson cards were detected. Falling back to playlist requests from the current page...",
      );
      logWarn("lessons", "No lesson cards detected; using fallback flow", {
        currentUrl: page.url(),
        capturedPlaylists: Array.from(playlistUrls),
        recentObservedRequests: observedRequests.slice(-20),
      });
      await wait(5000);

      const collectedUrls = collectUniquePlaylistUrls(playlistUrls);

      if (collectedUrls.length === 0) {
        throw new Error(
          `Could not find any '${playlistFileName}' network requests. Please check the URL.`,
        );
      }

      console.log(`Found ${collectedUrls.length} unique playlist URL(s) to download.`);
      const downloads = collectedUrls.map((streamUrl, index) => ({
        streamUrl,
        outputName: buildOutputName(discipline, index),
      }));
      const cookieFilePath = await writeCookiesFile(page, collectedUrls);

      await launchDownloadTasks(downloads, cookieFilePath);
    }

    console.log("\nAll download tasks have been launched.");
  } catch (error) {
    logError("main", "Unexpected error in main script", {
      error: error.message || String(error),
      stack: error.stack,
    });
    console.error("An unexpected error occurred in the main script:", error);
  } finally {
    if (browser) await browser.close();
    rl.close();
  }
}

scrap();
