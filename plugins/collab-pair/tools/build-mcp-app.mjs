#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = join(ROOT, 'ui', 'mcp-app.template.html');
const cssPath = join(ROOT, 'ui', 'src', 'app.css');
const appPath = join(ROOT, 'ui', 'src', 'app.js');
const sdkPath = join(ROOT, 'ui', 'vendor', 'ext-apps', 'app-with-deps.js');
const outputPath = join(ROOT, 'dist', 'mcp-app.html');

const template = readFileSync(templatePath, 'utf8');
const css = readFileSync(cssPath, 'utf8');
const appSource = readFileSync(appPath, 'utf8');
const sdkSource = readFileSync(sdkPath, 'utf8');

function localExportName(source, exportedName) {
  const match = source.match(new RegExp(`([A-Za-z_$][\\w$]*) as ${exportedName}\\b`, 'u'));
  if (match === null) throw new Error(`Could not find export ${exportedName} in MCP Apps bundle`);
  return match[1];
}

const sdkSymbols = Object.fromEntries(
  [
    'App',
    'applyDocumentTheme',
    'applyHostStyleVariables',
    'applyHostFonts',
  ].map((name) => [name, localExportName(sdkSource, name)]),
);

const sdkBridge = `
globalThis.__COLLAB_MCP_APP_SDK__ = Object.freeze({
  App: ${sdkSymbols.App},
  applyDocumentTheme: ${sdkSymbols.applyDocumentTheme},
  applyHostStyleVariables: ${sdkSymbols.applyHostStyleVariables},
  applyHostFonts: ${sdkSymbols.applyHostFonts},
});
`;

const safeScript = (source) => source.replaceAll('</script', '<\\/script');
const bundle = `${safeScript(sdkSource)}\n${sdkBridge}\n${safeScript(appSource)}`;

const html = template
  .replace('/*__COLLAB_APP_CSS__*/', () => css)
  .replace('/*__MCP_APPS_BUNDLE__*/', () => bundle)
  .replace('/*__COLLAB_APP_JS__*/', '');

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, html, 'utf8');
process.stdout.write(`${outputPath}\n`);
