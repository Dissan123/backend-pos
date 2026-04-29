// backend/src/controllers/receiptController.js

const { generateReceiptPdf } = require('../services/receiptPdf');
const { getDb } = require('../db/localDb');

// GET /api/receipts/:saleId/pdf?format=thermal|a4
// Streams a PDF to the client for download or printing
const downloadReceiptPdf = async (req, res) => {
  const { saleId } = req.params;
  const format     = req.query.format === 'a4' ? 'a4' : 'thermal';

  try {
    const db   = getDb();
    const sale = db.prepare('SELECT receipt_number FROM sales WHERE id = ?').get(saleId);
    if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' });

    const pdfBuffer = await generateReceiptPdf(saleId, format);
    const filename  = `receipt-${sale.receipt_number}-${format}.pdf`;

    res.setHeader('Content-Type',        'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length',      pdfBuffer.length);
    res.end(pdfBuffer);
  } catch (err) {
    console.error('PDF generation error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/receipts/:saleId/thermal-data
// Returns ESC/POS command bytes for direct thermal printer communication
const getThermalData = (req, res) => {
  const db   = getDb();
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.saleId);
  if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' });

  const items    = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(sale.id);
  const settings = db.prepare('SELECT key, value FROM settings').all();
  const store    = Object.fromEntries(settings.map(s => [s.key, s.value]));
  const currency = store.currency || 'UGX';
  const fmt      = (n) => `${currency} ${Number(n || 0).toLocaleString()}`;

  // Build ESC/POS command sequence as a JSON structure
  // The frontend will convert this to actual ESC/POS bytes via the Web Serial API
  const commands = buildEscPosCommands(sale, items, store, fmt);

  return res.json({ success: true, data: { commands, sale_id: sale.id, receipt_number: sale.receipt_number } });
};

// ── ESC/POS command builder ──────────────────────────────────
function buildEscPosCommands(sale, items, store, fmt) {
  const ESC = 0x1B;
  const GS  = 0x1D;
  const LF  = 0x0A;

  // Returns a structured list of print commands
  // The browser-side thermal printer service converts these to bytes
  return [
    { type: 'init' },
    { type: 'align',   value: 'center' },
    { type: 'bold',    value: true },
    { type: 'size',    value: 'double' },
    { type: 'text',    value: store.store_name || 'MY STORE' },
    { type: 'feed',    lines: 1 },
    { type: 'size',    value: 'normal' },
    { type: 'bold',    value: false },
    ...(store.store_address ? [{ type: 'text', value: store.store_address }] : []),
    ...(store.store_phone   ? [{ type: 'text', value: store.store_phone   }] : []),
    { type: 'feed',    lines: 1 },
    { type: 'divider', style: 'dashed' },
    { type: 'align',   value: 'left' },
    { type: 'text',    value: `Date:    ${new Date(sale.created_at).toLocaleString('en-GB')}` },
    { type: 'text',    value: `Receipt: ${sale.receipt_number}` },
    { type: 'divider', style: 'dashed' },

    // Column header
    { type: 'columns', cols: [
      { text: 'ITEM',   width: 0.40 },
      { text: 'QTY',    width: 0.12 },
      { text: 'PRICE',  width: 0.24 },
      { text: 'TOTAL',  width: 0.24, align: 'right' },
    ]},
    { type: 'divider', style: 'dashed' },

    // Items
    ...items.map(item => ({
      type: 'columns',
      cols: [
        { text: item.product_name.slice(0, 20), width: 0.40 },
        { text: String(item.quantity),           width: 0.12 },
        { text: Number(item.unit_price).toLocaleString(), width: 0.24 },
        { text: Number(item.subtotal).toLocaleString(),   width: 0.24, align: 'right' },
      ],
    })),

    { type: 'divider', style: 'dashed' },
    { type: 'spacer',  value: [
      { label: 'Subtotal', value: fmt(sale.subtotal) },
      ...(sale.discount > 0 ? [{ label: 'Discount', value: `-${fmt(sale.discount)}` }] : []),
    ]},
    { type: 'bold', value: true },
    { type: 'size', value: 'double-height' },
    { type: 'spacer', value: [{ label: 'TOTAL', value: fmt(sale.total_amount) }] },
    { type: 'size',   value: 'normal' },
    { type: 'bold',   value: false },
    { type: 'spacer', value: [
      { label: 'Cash Paid', value: fmt(sale.amount_paid) },
      { label: 'Change',    value: fmt(sale.change_given) },
    ]},
    { type: 'divider', style: 'dashed' },
    { type: 'align',   value: 'center' },
    { type: 'text',    value: store.receipt_footer || 'Thank you!' },
    { type: 'feed',    lines: 4 },
    { type: 'cut' },
  ];
}

module.exports = { downloadReceiptPdf, getThermalData };
