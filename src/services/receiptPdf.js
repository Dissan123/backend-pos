// backend/src/services/receiptPdf.js
// Generates professional PDF receipts using PDFKit
// Supports both A4 invoice format and 80mm thermal roll format

const PDFDocument = require('pdfkit');
const { getDb }   = require('../db/localDb');

/**
 * Generate a PDF receipt buffer for a given sale
 * @param {string} saleId
 * @param {'thermal'|'a4'} format
 * @returns {Promise<Buffer>}
 */
const generateReceiptPdf = (saleId, format = 'thermal') => {
  return new Promise((resolve, reject) => {
    const db = getDb();

    // Fetch sale
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!sale) return reject(new Error('Sale not found'));

    // Fetch items
    const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);

    // Fetch store settings
    const settingsRows = db.prepare('SELECT key, value FROM settings').all();
    const store = Object.fromEntries(settingsRows.map(s => [s.key, s.value]));
    const currency = store.currency || 'UGX';
    const fmt = (n) => `${currency} ${Number(n || 0).toLocaleString()}`;

    // ── Document setup ──────────────────────────────────────
    const isThermal = format === 'thermal';
    const pageWidth = isThermal ? 226.77 : 595.28; // 80mm = 226.77pt | A4 = 595.28pt
    const margins   = isThermal ? { top: 20, bottom: 20, left: 16, right: 16 } : { top: 50, bottom: 50, left: 60, right: 60 };
    const contentW  = pageWidth - margins.left - margins.right;

    const doc = new PDFDocument({
      size:    isThermal ? [pageWidth, 841.89] : 'A4',
      margins,
      autoFirstPage: true,
      bufferPages: true,
    });

    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const x  = margins.left;
    let   y  = margins.top;
    const rX = margins.left + contentW; // right edge

    const moveDown = (pts = 8) => { y += pts; doc.y = y; };

    // ── Helper: dashed line ──────────────────────────────────
    const dashedLine = (yPos) => {
      doc.save()
         .dash(3, { space: 3 })
         .moveTo(x, yPos).lineTo(rX, yPos)
         .stroke('#cccccc')
         .undash()
         .restore();
    };

    // ─────────────────────────────────────────────────────────
    // THERMAL FORMAT
    // ─────────────────────────────────────────────────────────
    if (isThermal) {
      const fw = isThermal ? 9 : 10;
      doc.font('Courier');

      // Store name
      doc.fontSize(14).font('Courier-Bold')
         .text(store.store_name || 'MY STORE', x, y, { width: contentW, align: 'center' });
      moveDown(16);

      // Address + phone
      if (store.store_address) {
        doc.fontSize(fw).font('Courier')
           .text(store.store_address, x, y, { width: contentW, align: 'center' });
        moveDown(12);
      }
      if (store.store_phone) {
        doc.fontSize(fw).text(store.store_phone, x, y, { width: contentW, align: 'center' });
        moveDown(12);
      }

      dashedLine(y); moveDown(10);

      // Receipt info
      const dateStr = new Date(sale.created_at).toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
      doc.fontSize(fw).font('Courier')
         .text(`Date:    ${dateStr}`, x, y, { width: contentW });
      moveDown(12);
      doc.text(`Receipt: ${sale.receipt_number}`, x, y, { width: contentW });
      moveDown(12);

      dashedLine(y); moveDown(10);

      // Column headers
      doc.fontSize(fw).font('Courier-Bold');
      doc.text('ITEM', x, y);
      doc.text('QTY', x + contentW * 0.52, y);
      doc.text('PRICE', x + contentW * 0.68, y);
      doc.text('TOTAL', x + contentW * 0.84, y);
      moveDown(12);
      dashedLine(y); moveDown(8);

      // Items
      doc.font('Courier').fontSize(fw - 1);
      items.forEach(item => {
        const name = item.product_name.length > 22
          ? item.product_name.slice(0, 20) + '…'
          : item.product_name;

        doc.text(name,                             x,                    y, { width: contentW * 0.5 });
        doc.text(String(item.quantity),            x + contentW * 0.52,  y);
        doc.text(Number(item.unit_price).toLocaleString(), x + contentW * 0.62, y);
        doc.text(Number(item.subtotal).toLocaleString(),   x + contentW * 0.80,  y);
        moveDown(12);
      });

      dashedLine(y); moveDown(10);

      // Totals
      const totalRows = [
        ['Subtotal:',    fmt(sale.subtotal)],
        sale.discount > 0 ? ['Discount:',  `-${fmt(sale.discount)}`] : null,
        sale.tax > 0       ? ['Tax:',        fmt(sale.tax)]           : null,
        ['TOTAL:',       fmt(sale.total_amount)],
        ['Cash Paid:',   fmt(sale.amount_paid)],
        ['Change:',      fmt(sale.change_given)],
      ].filter(Boolean);

      totalRows.forEach(([label, val], i) => {
        const isBig = label === 'TOTAL:';
        doc.fontSize(isBig ? fw + 1 : fw)
           .font(isBig ? 'Courier-Bold' : 'Courier');
        doc.text(label, x, y);
        doc.text(val,   x, y, { width: contentW, align: 'right' });
        moveDown(isBig ? 14 : 12);
      });

      dashedLine(y); moveDown(14);

      // Footer
      doc.fontSize(fw - 1).font('Courier')
         .text(store.receipt_footer || 'Thank you for shopping with us!', x, y, { width: contentW, align: 'center' });
      moveDown(12);
      doc.text('Powered by POS System', x, y, { width: contentW, align: 'center' });

      // Trim page to content
      const finalY = y + 30;
      doc.page.height = finalY;
    }

    // ─────────────────────────────────────────────────────────
    // A4 INVOICE FORMAT
    // ─────────────────────────────────────────────────────────
    else {
      // Header band
      doc.rect(0, 0, pageWidth, 110).fill('#0a0b0e');

      doc.fillColor('#f0b429').fontSize(22).font('Helvetica-Bold')
         .text(store.store_name || 'My Store', x, 30, { width: contentW });
      doc.fillColor('#888888').fontSize(9).font('Helvetica')
         .text([store.store_address, store.store_phone].filter(Boolean).join('  ·  '), x, 56, { width: contentW });
      doc.fillColor('#f0b429').fontSize(18).font('Helvetica-Bold')
         .text('RECEIPT', x, 30, { width: contentW, align: 'right' });
      doc.fillColor('#ffffff').fontSize(9).font('Helvetica')
         .text(sale.receipt_number, x, 56, { width: contentW, align: 'right' });

      y = 130;

      // Meta row
      doc.fillColor('#333333').fontSize(9).font('Helvetica');
      const metaDate = new Date(sale.created_at).toLocaleString('en-GB', {
        day: '2-digit', month: 'long', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
      doc.text(`Date: ${metaDate}`, x, y);
      doc.text(`Payment: ${sale.payment_method}`, x + contentW / 2, y, { width: contentW / 2, align: 'right' });
      y += 28;

      // Items table header
      doc.rect(x, y, contentW, 22).fill('#f0f0f0');
      doc.fillColor('#333333').fontSize(8.5).font('Helvetica-Bold');
      doc.text('ITEM',         x + 6,               y + 6);
      doc.text('QTY',          x + contentW * 0.58,  y + 6);
      doc.text('UNIT PRICE',   x + contentW * 0.68,  y + 6);
      doc.text('SUBTOTAL',     x + contentW * 0.84,  y + 6);
      y += 22;

      // Items rows
      items.forEach((item, i) => {
        if (i % 2 === 0) doc.rect(x, y, contentW, 20).fill('#fafafa');
        doc.fillColor('#222222').fontSize(9).font('Helvetica');
        doc.text(item.product_name,                        x + 6,               y + 5, { width: contentW * 0.56 });
        doc.text(String(item.quantity),                    x + contentW * 0.58, y + 5);
        doc.text(fmt(item.unit_price),                     x + contentW * 0.65, y + 5);
        doc.text(fmt(item.subtotal),                       x + contentW * 0.82, y + 5, { width: contentW * 0.18, align: 'right' });
        y += 20;
      });

      // Totals section
      y += 16;
      doc.moveTo(x, y).lineTo(rX, y).stroke('#e0e0e0');
      y += 14;

      const totals = [
        ['Subtotal',    fmt(sale.subtotal),      false],
        sale.discount > 0 ? ['Discount', `-${fmt(sale.discount)}`, false] : null,
        sale.tax > 0       ? ['Tax',      fmt(sale.tax),             false] : null,
        ['TOTAL',       fmt(sale.total_amount),  true ],
        ['Cash Paid',   fmt(sale.amount_paid),   false],
        ['Change',      fmt(sale.change_given),  false],
      ].filter(Boolean);

      totals.forEach(([label, val, big]) => {
        const lx = x + contentW * 0.55;
        const lw = contentW * 0.45;
        if (big) {
          doc.rect(lx - 8, y - 4, lw + 8, 24).fill('#f0b429');
          doc.fillColor('#0a0b0e').fontSize(11).font('Helvetica-Bold');
        } else {
          doc.fillColor('#555555').fontSize(9).font('Helvetica');
        }
        doc.text(label, lx, y, { width: lw * 0.5 });
        doc.text(val,   lx, y, { width: lw,      align: 'right' });
        y += big ? 26 : 18;
      });

      y += 20;
      doc.moveTo(x, y).lineTo(rX, y).stroke('#e0e0e0');
      y += 20;

      // Footer
      doc.fillColor('#aaaaaa').fontSize(8).font('Helvetica')
         .text(store.receipt_footer || 'Thank you for your business!', x, y, { width: contentW, align: 'center' });
    }

    doc.end();
  });
};

module.exports = { generateReceiptPdf };
