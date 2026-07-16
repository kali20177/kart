import { contextBridge, ipcRenderer } from 'electron'

let winId: number | null = null

async function getWinId(): Promise<number> {
  if (winId === null) {
    winId = await ipcRenderer.invoke('recorder:get-window-id') as number
  }
  return winId
}

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  versions: process.versions,
  toggleDevTools: () => ipcRenderer.send('toggle-devtools'),

  recorder: {
    openSaveDialog: (suggestedName: string) =>
      ipcRenderer.invoke('recorder:open-save-dialog', suggestedName),
    writeChunk: async (chunk: Uint8Array) => {
      const id = await getWinId()
      ipcRenderer.send('recorder:write-chunk', id, chunk)
    },
    closeFile: async () => {
      const id = await getWinId()
      ipcRenderer.send('recorder:close-file', id)
    }
  }
})
