import { resolve } from "path";
import readline from "readline";
let scrappingLink = "";
let discipline = "";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function askQuestion(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

async function main() {
  scrappingLink = await askQuestion("What do you want to scrap?");
  discipline = await askQuestion("What is the name of the discipline?");

  console.log("scrapping link: ", scrappingLink);
  console.log("output name: ", discipline);

  rl.close();
}
main();
