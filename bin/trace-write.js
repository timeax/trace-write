#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);

const options = {
   force: false,
   dryRun: false,
   backup: false,
   list: false,
   only: [],
};

const positional = [];

for (let i = 0; i < args.length; i++) {
   const arg = args[i];

   switch (arg) {
      case "--force":
      case "-f":
         options.force = true;
         break;

      case "--dry-run":
         options.dryRun = true;
         break;

      case "--backup":
         options.backup = true;
         break;

      case "--list":
      case "-l":
         options.list = true;
         break;

      case "--only":
      case "-o": {
         const value = args[++i];

         if (!value) {
            fail("--only requires a file path.");
         }

         options.only.push(normalizeTracePath(value));
         break;
      }

      case "--help":
      case "-h":
         printHelp();
         process.exit(0);

      default:
         positional.push(arg);
         break;
   }
}

const [traceInput, outputInput] = positional;

if (!traceInput) {
   printHelp();
   process.exit(1);
}

if (!options.list && !outputInput) {
   fail("A destination folder is required unless --list is used.");
}

const traceFile = path.resolve(traceInput);
const outputDir = outputInput ? path.resolve(outputInput) : null;

if (!fs.existsSync(traceFile)) {
   fail(`Trace file does not exist:\n${traceFile}`);
}

if (!fs.statSync(traceFile).isFile()) {
   fail(`Trace path is not a file:\n${traceFile}`);
}

const raw = fs.readFileSync(traceFile, "utf8");

const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

let manifest = parseManifest(lines);

if (manifest.length === 0) {
   fail("Index missing/malformed: no indexed source files were found.");
}

/*
 * Filter by --only when requested.
 */
if (options.only.length > 0) {
   manifest = filterManifest(manifest, options.only);

   if (manifest.length === 0) {
      fail(`None of the requested --only paths were found in the trace index.`);
   }
}

/*
 * Listing mode.
 */
if (options.list) {
   printManifest(manifest);
   process.exit(0);
}

console.log(
   `\nTrace:  ${traceFile}\nTarget: ${outputDir}\nFiles:  ${manifest.length}\n`,
);

let written = 0;
let skipped = 0;

for (const item of manifest) {
   const result = extractIndexedFile(lines, item);

   const destination = safeDestination(outputDir, item.filePath);

   if (!result) {
      console.error(
         `✗ Could not extract ${item.filePath} from L${item.start}-L${item.end}`,
      );

      skipped++;
      continue;
   }

   const exists = fs.existsSync(destination);

   if (exists && !options.force) {
      console.log(`○ Skip   ${item.filePath} (already exists)`);

      skipped++;
      continue;
   }

   if (options.dryRun) {
      console.log(
         `${exists ? "↻ Would overwrite" : "+ Would write"} ${item.filePath}`,
      );

      continue;
   }

   fs.mkdirSync(path.dirname(destination), {
      recursive: true,
   });

   if (exists && options.backup) {
      createBackup(destination);
   }

   fs.writeFileSync(destination, result, "utf8");

   console.log(`${exists ? "↻ Write" : "+ Write"}  ${item.filePath}`);

   written++;
}

console.log("");

if (options.dryRun) {
   console.log(
      `Dry run complete. ${manifest.length} file(s) matched. No files were changed.`,
   );
} else {
   console.log(`Done. ${written} file(s) written, ${skipped} skipped.`);
}

function filterManifest(manifest, requested) {
   const wanted = requested.map(normalizeTracePath);

   return manifest.filter((item) => {
      const file = normalizeTracePath(item.filePath);

      return wanted.some((target) => {
         /*
          * Exact path:
          *
          * --only app/Support/Http/BackResponder.php
          */
         if (file === target) {
            return true;
         }

         /*
          * Allow directory selection:
          *
          * --only app/Support
          */
         const prefix = target.endsWith("/") ? target : `${target}/`;

         return file.startsWith(prefix);
      });
   });
}

function printManifest(manifest) {
   console.log(`\nIndexed files: ${manifest.length}\n`);

   const idWidth = Math.max(
      2,
      String(Math.max(...manifest.map((item) => item.id))).length,
   );

   for (const item of manifest) {
      const id = String(item.id).padStart(idWidth, " ");

      console.log(`${id}  L${item.start}-L${item.end}  ${item.filePath}`);
   }

   console.log("");
}

function parseManifest(lines) {
   const firstTen = lines.slice(0, 10).join("\n");

   const hasClassicHeader =
      /^# Index\s*$/m.test(firstTen) ||
      /Included Source Files:\s*\d+/i.test(firstTen) ||
      /Included Sections:\s*\d+/i.test(firstTen);

   const prodexRange = findProdexRange(lines);

   let indexLines;

   if (prodexRange) {
      indexLines = lines.slice(prodexRange.start - 1, prodexRange.end);
   } else {
      const indexLocation = findClassicIndex(lines, hasClassicHeader);

      if (!indexLocation) {
         fail("Index missing/malformed.");
      }

      indexLines = lines.slice(indexLocation.start, indexLocation.end);
   }

   const entryPattern = /^-\s+\[(.+?)]\(#(\d+)\)\s+L(\d+)-L(\d+)\s*$/;

   const manifest = [];

   for (const line of indexLines) {
      const match = line.match(entryPattern);

      if (!match) {
         continue;
      }

      manifest.push({
         id: Number(match[2]),
         filePath: normalizeTracePath(match[1]),
         start: Number(match[3]),
         end: Number(match[4]),
      });
   }

   return manifest;
}

function findProdexRange(lines) {
   const initialLimit = Math.min(lines.length, 50);

   for (let i = 0; i < initialLimit; i++) {
      const match = lines[i].match(
         /<!--\s*PRODEX_INDEX_RANGE:\s*L(\d+)-L(\d+)\s*-->/i,
      );

      if (match) {
         return {
            start: Number(match[1]),
            end: Number(match[2]),
         };
      }
   }

   for (let i = initialLimit; i < lines.length; i++) {
      if (!lines[i].includes("PRODEX_INDEX_RANGE")) {
         continue;
      }

      const match = lines[i].match(
         /<!--\s*PRODEX_INDEX_RANGE:\s*L(\d+)-L(\d+)\s*-->/i,
      );

      if (match) {
         return {
            start: Number(match[1]),
            end: Number(match[2]),
         };
      }
   }

   return null;
}

function findClassicIndex(lines, alreadyDetected) {
   let start = -1;

   if (alreadyDetected) {
      start = lines.slice(0, 10).findIndex((line) => line.trim() === "# Index");
   }

   if (start === -1) {
      start = lines.findIndex((line) => line.trim() === "# Index");
   }

   if (start === -1) {
      return null;
   }

   let end = start + 1;

   while (end < lines.length) {
      const line = lines[end];

      if (
         end > start + 1 &&
         /^#{1,4}\s+/.test(line) &&
         !/Included (Source Files|Sections):/i.test(line)
      ) {
         break;
      }

      if (/^---\s*$/.test(line) && end > start + 2) {
         break;
      }

      end++;
   }

   return {
      start,
      end,
   };
}

function extractIndexedFile(lines, item) {
   if (item.start < 1 || item.end < item.start || item.end > lines.length) {
      return null;
   }

   const section = lines.slice(item.start - 1, item.end);

   let openingIndex = -1;
   let fence = null;

   for (let i = 0; i < section.length; i++) {
      const match = section[i].match(/^(`{3,}|~{3,})(.*)$/);

      if (!match) {
         continue;
      }

      openingIndex = i;
      fence = match[1];

      break;
   }

   if (openingIndex === -1 || !fence) {
      return null;
   }

   let closingIndex = -1;

   for (let i = section.length - 1; i > openingIndex; i--) {
      if (section[i].trim() === fence) {
         closingIndex = i;
         break;
      }
   }

   if (closingIndex === -1) {
      return null;
   }

   const content = section.slice(openingIndex + 1, closingIndex).join("\n");

   return `${content.replace(/\n+$/, "")}\n`;
}

function safeDestination(root, tracePath) {
   const normalized = normalizeTracePath(tracePath);

   if (path.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
      fail(`Unsafe absolute path in trace: ${tracePath}`);
   }

   const rootResolved = path.resolve(root);

   const destination = path.resolve(rootResolved, normalized);

   const relative = path.relative(rootResolved, destination);

   if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
   ) {
      fail(`Unsafe path traversal in trace: ${tracePath}`);
   }

   return destination;
}

function normalizeTracePath(value) {
   return value
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "")
      .replace(/\/+$/, "")
      .trim();
}

function createBackup(destination) {
   let backup = `${destination}.bak`;

   if (fs.existsSync(backup)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");

      backup = `${destination}.${stamp}.bak`;
   }

   fs.copyFileSync(destination, backup);

   console.log(`  Backup ${path.relative(process.cwd(), backup)}`);
}

function printHelp() {
   console.log(`
trace-write

Extract source files from a PRODEx / indexed trace bundle.

Usage:
  trace-write <trace-file> <destination> [options]
  trace-write <trace-file> --list

Examples:
  trace-write trace.md --list

  trace-write trace.md .

  trace-write trace.md D:\\Projects\\Herd\\ambydatesyrup

  trace-write trace.md . \\
    --only app/Support/Http/BackResponder.php

  trace-write trace.md . \\
    --only app/Support \\
    --force

  trace-write trace.md . \\
    --only app/Data/Notice.php \\
    --only app/Support/Http/BackResponder.php

  trace-write trace.md . \\
    --force \\
    --backup

  trace-write trace.md . \\
    --dry-run

Options:
  -l, --list
      List indexed files without writing anything.

  -o, --only <path>
      Extract only a specific indexed file or directory.
      May be supplied multiple times.

  -f, --force
      Overwrite existing files.

      --backup
      Create a backup before overwriting.

      --dry-run
      Show what would happen without modifying files.

  -h, --help
      Show this help.
`);
}

function fail(message) {
   console.error(`\ntrace-write: ${message}\n`);

   process.exit(1);
}
