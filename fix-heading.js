const fs = require("fs");

function insertLineAfter(path, anchorIncludes, nextLineIncludes, newLine) {
  const raw = fs.readFileSync(path, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r\n|\n/);

  const idx = lines.findIndex(
    (line, i) =>
      line.includes(anchorIncludes) &&
      lines[i + 1] &&
      lines[i + 1].includes(nextLineIncludes),
  );

  if (idx === -1) {
    throw new Error(`Could not find expected anchor lines in ${path}. The file may already be fixed or has changed — check it manually.`);
  }

  lines.splice(idx + 1, 0, newLine);
  fs.writeFileSync(path, lines.join(eol), "utf8");
  console.log(`Updated ${path}`);
}

// 1. page.tsx — add sr-only h2 right before the Features grid <div>
insertLineAfter(
  "frontend/src/app/page.tsx",
  "mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16",
  "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4",
  '        <h2 className="sr-only">Features</h2>',
);

// 2. a11y.spec.tsx — add a new test case right before the deposit page test
function insertBefore(path, targetIncludes, newLines) {
  const raw = fs.readFileSync(path, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r\n|\n/);

  const idx = lines.findIndex((line) => line.includes(targetIncludes));
  if (idx === -1) {
    throw new Error(`Could not find expected anchor line in ${path}. The file may already be fixed or has changed — check it manually.`);
  }

  lines.splice(idx, 0, ...newLines);
  fs.writeFileSync(path, lines.join(eol), "utf8");
  console.log(`Updated ${path}`);
}

insertBefore(
  "frontend/src/app/a11y.spec.tsx",
  'it("deposit page has no axe violations"',
  [
    '  it("home page has no axe violations", async () => {',
    '    const { default: Home } = await import("./page");',
    "    const { container } = render(<Home />);",
    "    const results = await axe(container);",
    "    expect(results).toHaveNoViolations();",
    "  });",
    "",
  ],
);

// 3. CHANGELOG.md — append the Fixed entry
const changelogPath = "CHANGELOG.md";
const changelogRaw = fs.readFileSync(changelogPath, "utf8");
const changelogEol = changelogRaw.includes("\r\n") ? "\r\n" : "\n";
const entry =
  changelogEol +
  changelogEol +
  "### Fixed" +
  changelogEol +
  changelogEol +
  "- Fixed a heading-order accessibility violation on the landing page (Features section jumped from h1 to h3) and added regression test coverage for the home page in the axe-core suite" +
  changelogEol;
fs.writeFileSync(changelogPath, changelogRaw.replace(/\s*$/, "") + entry, "utf8");
console.log(`Updated ${changelogPath}`);

console.log("Done: heading-order fix applied.");
