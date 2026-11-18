import { mountLinkBridge } from './linkBridge/linkPeer'

// The hidden link-bridge window loads the same renderer entry with ?linkBridge=1:
// it only mounts the WebRTC answerer, never the app UI.
if (new URLSearchParams(window.location.search).has('linkBridge')) {
  mountLinkBridge()
} else {
  void (async () => {
    const React = (await import('react')).default
    const ReactDOM = (await import('react-dom/client')).default
    const { default: App } = await import('./App')
    await import('./styles.css')
    ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    )
  })()
}
