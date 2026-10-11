// Electron entry point for an isolated E2E session. Only file chooser results are stubbed.
const { app, dialog, shell } = require('electron')
const { resolve, relative, isAbsolute, parse, join } = require('node:path')
const { existsSync } = require('node:fs')
const root = resolve(__dirname, '../..')
const artifacts = resolve(root, 'tools/sync-validation-output')
function artifact(name) {
  if (!name) throw new Error('E2E artifact environment variable is required')
  const path = resolve(name), rel = relative(artifacts, path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('E2E artifacts must stay in tools/sync-validation-output')
  return path
}
const output = artifact(process.env.AUTOSUBTITLE_E2E_OUTPUT)
const project = artifact(process.env.AUTOSUBTITLE_E2E_PROJECT)
const savedProject = process.env.AUTOSUBTITLE_E2E_SAVE_PROJECT ? artifact(process.env.AUTOSUBTITLE_E2E_SAVE_PROJECT) : null
if (savedProject && existsSync(savedProject)) throw new Error('Choose a new project output')
const parsedOutput = parse(output)
if (existsSync(output) || existsSync(join(parsedOutput.dir, parsedOutput.name + '_AutoSubtitle' + parsedOutput.ext))) {
  throw new Error('Choose a new export output; E2E will not overwrite an existing file')
}
if (!existsSync(project)) throw new Error('E2E project fixture is missing')
// Optional queue enables project reopen/missing-media/relink scenarios via real UI.
const openQueue = process.env.AUTOSUBTITLE_E2E_OPEN_QUEUE
  ? JSON.parse(process.env.AUTOSUBTITLE_E2E_OPEN_QUEUE).map(artifact) : []
dialog.showSaveDialog = async (_parent, options) => ({ canceled: false,
  filePath: savedProject && options?.filters?.some(f => f.extensions.includes('autosub')) ? savedProject : output })
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [openQueue.shift() ?? project] })
shell.showItemInFolder = () => {}
app.setAppPath(root)
require('../../out/main/index.js')
