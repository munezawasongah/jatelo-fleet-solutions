import PDFDocument from 'pdfkit';

export interface InvoiceDoc {
  number: string;
  status: string;
  issued_at: string | Date | null;
  due_date: string | Date;
  period_start: string | Date;
  period_end: string | Date;
  currency: string;
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  total: number;
  amount_paid: number;
  lines: { description: string; quantity: number; unit_price: number; amount: number; note?: string }[];
  customer: { name: string; legal_name?: string | null; tax_id?: string | null; address?: string | null; email?: string | null; country_code: string };
  payments: { method: string; amount: number; provider_reference: string | null; paid_at: string | Date | null }[];
}

const SELLER = {
  name: 'Jatelo Technologies',
  product: 'Jatelo Fleet Solutions',
  address: 'Nairobi, Kenya',
  email: 'billing@jatelo-techs.com',
  web: 'jatelo-techs.com',
};

const d = (v: string | Date | null): string => (v ? (v instanceof Date ? v : new Date(String(v))).toISOString().slice(0, 10) : '-');
const money = (cur: string, v: number): string => `${cur} ${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Renders a tax invoice as PDF (A4 portrait). */
export function renderInvoicePdf(inv: InvoiceDoc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Invoice ${inv.number}`, Author: SELLER.name } });
    const chunks: Buffer[] = [];
    doc.on('data', (b: Buffer) => chunks.push(b));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const GREEN = '#0F6B4F';
    const W = doc.page.width - 96;

    doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(20).text(SELLER.product, 48, 48);
    doc.fillColor('#555').font('Helvetica').fontSize(9).text(`${SELLER.name} · ${SELLER.address} · ${SELLER.email} · ${SELLER.web}`);
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(16).text(inv.tax_rate > 0 ? 'TAX INVOICE' : 'INVOICE', 48, 48, { width: W, align: 'right' });
    doc.font('Helvetica').fontSize(10).text(inv.number, { width: W, align: 'right' });
    const statusColor = inv.status === 'paid' ? GREEN : inv.status === 'overdue' ? '#B00020' : '#8A6D00';
    doc.fillColor(statusColor).font('Helvetica-Bold').text(inv.status.toUpperCase(), { width: W, align: 'right' });

    doc.moveDown(2);
    const top = doc.y;
    doc.fillColor('#777').font('Helvetica').fontSize(8).text('BILL TO', 48, top);
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(11).text(inv.customer.legal_name || inv.customer.name, 48, top + 12, { width: W / 2 });
    doc.font('Helvetica').fontSize(9);
    if (inv.customer.tax_id) doc.text(`${inv.customer.country_code === 'KE' ? 'KRA PIN' : 'TIN'}: ${inv.customer.tax_id}`, { width: W / 2 });
    if (inv.customer.address) doc.text(inv.customer.address, { width: W / 2 });
    if (inv.customer.email) doc.text(inv.customer.email, { width: W / 2 });

    const meta: [string, string][] = [
      ['Issue date', d(inv.issued_at)],
      ['Due date', d(inv.due_date)],
      ['Service period', `${d(inv.period_start)} to ${d(inv.period_end)}`],
      ['Currency', inv.currency],
    ];
    let y = top;
    for (const [k, v] of meta) {
      doc.fillColor('#777').fontSize(8).text(k, 48 + W / 2, y, { width: W / 4 });
      doc.fillColor('#111').fontSize(9).text(v, 48 + (3 * W) / 4, y, { width: W / 4, align: 'right' });
      y += 14;
    }

    doc.y = Math.max(doc.y, y) + 24;
    // lines table
    const cols = [W * 0.52, W * 0.12, W * 0.18, W * 0.18];
    const th = doc.y;
    doc.rect(48, th, W, 20).fill(GREEN);
    doc.fillColor('#FFF').font('Helvetica-Bold').fontSize(9);
    ['Description', 'Qty', 'Unit price', 'Amount'].forEach((h, i) => {
      const x = 48 + cols.slice(0, i).reduce((a, b) => a + b, 0);
      doc.text(h, x + 6, th + 6, { width: cols[i]! - 12, align: i === 0 ? 'left' : 'right' });
    });
    doc.font('Helvetica').fillColor('#111');
    let ry = th + 26;
    for (const l of inv.lines) {
      const cells = [l.description + (l.note ? `\n${l.note}` : ''), String(l.quantity), money(inv.currency, l.unit_price), money(inv.currency, l.amount)];
      let h = 0;
      cells.forEach((c, i) => {
        const x = 48 + cols.slice(0, i).reduce((a, b) => a + b, 0);
        doc.fontSize(9).text(c, x + 6, ry, { width: cols[i]! - 12, align: i === 0 ? 'left' : 'right' });
        h = Math.max(h, doc.heightOfString(c, { width: cols[i]! - 12 }));
      });
      ry += h + 10;
      doc.moveTo(48, ry - 5).lineTo(48 + W, ry - 5).strokeColor('#E3E3E3').stroke();
    }

    // totals
    const tot: [string, string, boolean][] = [
      ['Subtotal', money(inv.currency, inv.subtotal), false],
      [`VAT (${inv.tax_rate}%)`, money(inv.currency, inv.tax_amount), false],
      ['Total', money(inv.currency, inv.total), true],
      ['Paid', money(inv.currency, inv.amount_paid), false],
      ['Balance due', money(inv.currency, Math.max(0, inv.total - inv.amount_paid)), true],
    ];
    ry += 6;
    for (const [k, v, bold] of tot) {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9).fillColor('#111');
      doc.text(k, 48 + W * 0.5, ry, { width: W * 0.25 });
      doc.text(v, 48 + W * 0.75, ry, { width: W * 0.25, align: 'right' });
      ry += bold ? 18 : 14;
    }

    if (inv.payments.length) {
      ry += 10;
      doc.font('Helvetica-Bold').fontSize(10).text('Payments received', 48, ry);
      ry += 16;
      doc.font('Helvetica').fontSize(9);
      for (const p of inv.payments) {
        doc.text(`${d(p.paid_at)}  ·  ${p.method.replace('_', ' ').toUpperCase()}  ·  ${p.provider_reference ?? ''}`, 48, ry, { width: W * 0.7 });
        doc.text(money(inv.currency, p.amount), 48 + W * 0.7, ry, { width: W * 0.3, align: 'right' });
        ry += 14;
      }
    }

    ry += 24;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(GREEN).text('How to pay', 48, ry);
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(
      `M-Pesa: sign in to Jatelo Fleet Solutions > Billing > Pay with M-Pesa, or use Paybill with account number ${inv.number}. ` +
        'Bank transfer details are available on request from billing@jatelo-techs.com. Please quote the invoice number with every payment.',
      48,
      ry + 14,
      { width: W },
    );
    doc.fontSize(7).fillColor('#999').text('Thank you for choosing Jatelo Fleet Solutions.', 48, doc.page.height - 60, { width: W, align: 'center' });
    doc.end();
  });
}
