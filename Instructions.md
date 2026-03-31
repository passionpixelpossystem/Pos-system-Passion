# 📸 PASSION PIXEL - Studio Management & POS System

This document outlines the business and technical requirements for the Passion Pixel POS system, optimized for speed, offline reliability, and ease of use.

---

## 🚀 1. Overview
A lightweight, browser-based POS system designed for a photography studio. It handles standard shop services (printing, framing) and a high-speed Photobooth module.

**Tech Stack:**
* **Frontend:** HTML5, Tailwind CSS (Styling)
* **Logic:** JavaScript (ES6+)
* **Database:** [Dexie.js](https://dexie.org/) (IndexedDB wrapper for local storage)
* **PDF Generation:** [jspdf](https://parall.ax/products/jspdf) or [html2pdf.js](https://ekoopmans.github.io/html2pdf.js/)

---

## 🛠 2. Core Modules

### A. Dashboard & Income Tracker
* **Visual Summary:** Daily, Weekly, and Monthly income charts.
* **Event Alerts:** A "Upcoming Events" section that highlights dates from the book to prevent forgetting bookings.
* **Quick Stats:** Total prints today, Total frames sold, Total Photobooth sessions.

### B. Standard Shop POS (Photocopy, Framing, Editing)
* **Service Catalog:** Dropdown/Search for services (Laminating, 4x6 Print, etc.).
* **Order Management:** Add multiple items to a single bill.
* **Payment Status:** Mark as Paid, Advance Paid, or Credit.
* **PDF Invoice:** Generate a professional invoice with the "PASSION PIXEL" logo.

### C. ⚡ Photobooth Express Module (High Priority)
*Designed to handle the rush during events.*
* **Input Fields:**
    1.  **Photo Number:** (Unique ID from the camera).
    2.  **Phone Number:** (For digital delivery/contact).
    3.  **Photo Size:** (Selectable: 2x3, 4x6, Strip, etc.).
    4.  **Print Count:** (Number of copies).
    5.  **Frame Included?** (Toggle Switch: Yes/No).
    6.  **Frame Count:** (Only visible if Frame is Yes).
    7.  **Payment Amount:** (Auto-calculated based on selection).
* **Automated Logic:**
    * **Random Bill ID:** Generate a unique ID (e.g., `PP-BT-XXXXX`) using `Math.random()`.
    * **Quick Print:** One-click button to generate and download a small 3-inch wide PDF slip for the customer.

### D. Event Calendar
* A dedicated section to log: Event Name, Date, Venue, Package Type, and Reminder Toggle.

---

## 💾 3. Technical Requirements & Database Schema

Using **Dexie.js**, we will define the following stores:

```javascript
const db = new Dexie('PassionPixelDB');
db.version(1).stores({
  services: '++id, name, price',
  orders: '++id, billNo, customerPhone, totalAmount, date, type', // type: 'shop' or 'booth'
  events: '++id, title, eventDate, status',
  photobooth: '++id, billNo, photoNo, phone, size, prints, frames, total, timestamp'
});

