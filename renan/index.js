for (let i = 0; i < 1000; i++) {
  fetch(
    `https://cdn.pandavideo.com/vz-ab7bef4e-bdd/b208a428-693b-43a7-ac57-5dcd25abe25e/842x480/video${i}.ts`,
  ).then((response) => response.text());
}
