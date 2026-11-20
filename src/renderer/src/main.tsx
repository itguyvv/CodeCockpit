import './styles.css'

void (async () => {
  const React = (await import('react')).default
  const ReactDOM = (await import('react-dom/client')).default
  const { default: App } = await import('./App')
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
})()
