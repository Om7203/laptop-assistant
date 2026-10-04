import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const python = process.argv[2];
const projectRoot = process.argv[3];
if (!python || !projectRoot) throw new Error("Usage: node install_dependencies.mjs <python> <project-root>");

const packages = [
  ["faster-whisper", "1.2.1"],
  ["ctranslate2", "4.8.2"],
  ["huggingface-hub", "0.36.0"],
  ["tokenizers", "0.23.2"],
  ["av", "16.0.1"],
  ["onnxruntime", "1.30.0"],
  ["tqdm", "4.67.1"],
  ["numpy", "2.3.4"],
  ["pyyaml", "6.0.3"],
  ["filelock", "3.20.0"],
  ["fsspec", "2025.10.0"],
  ["hf-xet", "1.2.0"],
  ["packaging", "25.0"],
  ["requests", "2.32.5"],
  ["typing-extensions", "4.15.0"],
  ["charset-normalizer", "3.4.4"],
  ["idna", "3.11"],
  ["urllib3", "2.5.0"],
  ["certifi", "2025.10.5"],
  ["coloredlogs", "15.0.1"],
  ["flatbuffers", "25.9.23"],
  ["protobuf", "6.33.0"],
  ["sympy", "1.14.0"],
  ["humanfriendly", "10.0"],
  ["mpmath", "1.3.0"],
  ["pyreadline3", "3.5.4"],
  ["colorama", "0.4.6"],
];

const environmentConfig = await fsp.readFile(path.join(path.dirname(path.dirname(python)), "pyvenv.cfg"), "utf8");
const pythonVersion = environmentConfig.match(/^version\s*=\s*(3\.(?:9|11))(?:\.|$)/m)?.[1];
if (!new Set(["3.9", "3.11"]).has(pythonVersion)) throw new Error(`Unsupported Python ${pythonVersion}; use Python 3.9 or 3.11.`);
const pythonTag = pythonVersion.replace(".", "");
const wheelDirectory = path.join(projectRoot, ".voice-wheels");
await fsp.mkdir(wheelDirectory, { recursive: true });

const patterns = [
  /py3-none-any\.whl$/,
  /py2\.py3-none-any\.whl$/,
  new RegExp(`cp${pythonTag}-cp${pythonTag}-win_amd64\\.whl$`),
  new RegExp(`cp${pythonTag}-abi3-win_amd64\\.whl$`),
  ...(pythonVersion === "3.11" ? [/cp310-abi3-win_amd64\.whl$/] : []),
  /cp39-abi3-win_amd64\.whl$/,
  /cp38-abi3-win_amd64\.whl$/,
  /cp37-abi3-win_amd64\.whl$/,
];

const wheelPaths = [];
for (const [name, version] of packages) {
  const response = await fetch(`https://pypi.org/pypi/${name}/${version}/json`);
  if (!response.ok) throw new Error(`Could not fetch ${name} ${version}: HTTP ${response.status}`);
  const metadata = await response.json();
  const wheel = metadata.urls.find((candidate) => patterns.some((pattern) => pattern.test(candidate.filename)));
  if (!wheel) throw new Error(`No compatible Windows wheel was found for ${name} ${version}.`);
  const destination = path.join(wheelDirectory, wheel.filename);
  wheelPaths.push(destination);
  if (fs.existsSync(destination) && fs.statSync(destination).size === wheel.size) continue;
  console.log(`Downloading ${name} ${version}...`);
  const download = await fetch(wheel.url);
  if (!download.ok) throw new Error(`Could not download ${name}: HTTP ${download.status}`);
  await fsp.writeFile(destination, Buffer.from(await download.arrayBuffer()));
}

console.log(`Prepared ${wheelPaths.length} pinned speech packages.`);
