const fs = require("fs");

function replaceOnce(path, oldStr, newStr) {
  const content = fs.readFileSync(path, "utf8");
  if (!content.includes(oldStr)) {
    throw new Error(`Could not find expected text in ${path}. The file may already be fixed or has changed — check it manually.`);
  }
  fs.writeFileSync(path, content.split(oldStr).join(newStr), "utf8");
  console.log(`Updated ${path}`);
}

replaceOnce(
  "frontend/src/app/page.tsx",
  'https://github.com/tech-adrian/Dshield',
  'https://github.com/Dshield-xyz/Dshield',
);

replaceOnce(
  "frontend/src/components/Footer.tsx",
  'https://github.com/tech-adrian/Dshield',
  'https://github.com/Dshield-xyz/Dshield',
);

console.log("Done: GitHub link fixed in both files.");
