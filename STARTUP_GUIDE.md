# 🚀 DesignOS Startup Guide

Welcome to **DesignOS**! This guide will help you launch the application, understand the interface, and start designing.

---

## ⚡ Quick Start (Double-Click Launch)

To start everything with a single click, we have created a **DesignOS** shortcut on your Desktop!

1. Go to your Windows **Desktop**.
2. Double-click the **DesignOS** icon.
3. This will launch a console window that:
   - Starts **Ollama** (if it's not already running).
   - Verifies **CadQuery**.
   - Starts the **DesignOS Production Server** (using Waitress).
   - Automatically opens your web browser to `http://localhost:5000`.
4. Keep the console window open while you use the application. To close the app, simply close the console window or press `Ctrl + C` in it.

---

## 🛠️ Launching Manually

If you prefer to start DesignOS from its folder:
1. Open the project directory: `H:\DesignOS`
2. Double-click the file named `start.bat`.

---

## 💻 What Should I Click in the App?

Once the app loads in your browser (`http://localhost:5000`), you will see the **DesignOS workspace**. Here is a quick run-through of what to click and how to design:

### 1. The Main CAD View (3D Canvas)
* **Navigate**: Left-click and drag to rotate the camera, right-click and drag to pan, and scroll to zoom.
* **Select**: Click on faces, edges, or vertices to highlight them.

### 2. 2D Sketching (Edit in 2D)
* **How to enter**: Select a face (e.g., the top face) or a plane in the 3D viewer, and click the **"Edit in 2D"** button.
* **Sketching Controls**:
  - Draw rectangles or circles directly on the grid.
  - Set dimensions.
* **Fast Extrude**: Once drawn, enter a depth (e.g. `100` mm) and click **Extrude**. 
  - *Note: Simple extrusions bypass the AI entirely for instantaneous, accurate 2D sketch-to-3D projection!*

### 3. Prompt to Geometry (AI CAD Generation)
* If you want to build complex parts using natural language, click on the **Prompt to Geometry** tab on the sidebar.
* Type your instruction (e.g. *"Create a bracket with 4 mounting holes and rounded corners"*).
* Click **Generate**. The AI will generate and render the CAD model.
* **Undo Button**: If you make a mistake or don't like the AI output, click the **Undo** button in the Prompt to Geometry tab to revert to the previous model version instantly.

### 4. Measurements
* Switch to the **Measurement** mode/tool.
* Click on two vertices, edges, or borders to measure the exact distance between them in real-time. This helps you build precise engineering models.

---

## ⚠️ Troubleshooting & Requirements
* **Ollama**: DesignOS uses local AI models via Ollama. Make sure Ollama is installed on your machine. The startup script will try to launch it automatically.
* **Python/Conda Environment**: DesignOS runs in the Miniconda Python environment at `H:\Miniconda3`. If you get dependency errors, ensure CadQuery and Flask/Waitress are installed in that environment.
