import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import ReaderApp from './reader/components/ReaderApp.jsx'
import { store } from './reader/store.js'

store.init()
createRoot(document.getElementById('root')).render(<ReaderApp />)
