import { readFileSync } from 'fs';
import { marked } from 'marked';
import puppeteer from 'puppeteer';
import path from 'path';

const __dirname = path.dirname(new URL(import.meta.url).pathname);

// Configure marked to generate heading IDs
marked.use({
  renderer: {
    heading({ tokens, depth }) {
      const text = tokens.map(t => t.raw || t.text || '').join('');
      const slug = text.toLowerCase()
        .replace(/<[^>]*>/g, '') // Remove HTML tags
        .replace(/[^\w\s-]/g, '') // Remove special chars
        .replace(/\s+/g, '-') // Replace spaces with -
        .trim();
      return `<h${depth} id="${slug}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    }
  }
});

// Read and convert images to base64
function imageToBase64(imagePath) {
  try {
    const fullPath = path.join(__dirname, imagePath);
    const imageBuffer = readFileSync(fullPath);
    const ext = path.extname(imagePath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
    return `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
  } catch (e) {
    console.error(`Failed to load image: ${imagePath}`, e.message);
    return '';
  }
}

// Load all images as base64
const images = {
  'telnyx-logo.png': imageToBase64('telnyx-logo.png'),
  'workflow-editor.jpg': imageToBase64('workflow-editor.jpg'),
  'call-flow-editor.jpg': imageToBase64('call-flow-editor.jpg'),
  'agent-desktop-workflow.jpg': imageToBase64('agent-desktop-workflow.jpg'),
  'supervisor-call-history.jpg': imageToBase64('supervisor-call-history.jpg'),
};

let mdContent = readFileSync('./Agent-Assist-Workflows-Guide.md', 'utf-8');

// Replace image references with base64 data
for (const [filename, base64] of Object.entries(images)) {
  if (base64) {
    mdContent = mdContent.replace(new RegExp(`\\]\\(${filename}\\)`, 'g'), `](${base64})`);
  }
}

// Remove ASCII art diagram and replace with styled HTML
mdContent = mdContent.replace(/```[\s\S]*?┌─────────────────┐[\s\S]*?└──────────────────┘[\s\S]*?```/g, `

<div style="display: flex; flex-direction: column; align-items: center; margin: 30px 0; font-family: sans-serif;">
  <div style="display: flex; align-items: center; gap: 20px;">
    <div style="background: #1a1a2e; color: white; padding: 20px 25px; border-radius: 12px; text-align: center; border: 2px solid #00c853;">
      <div style="font-weight: bold;">Call Flow</div>
      <div style="font-size: 12px; opacity: 0.8;">(IVR/Routing)</div>
    </div>
    <div style="font-size: 24px; color: #00c853;">→</div>
    <div style="background: #1a1a2e; color: white; padding: 20px 25px; border-radius: 12px; text-align: center; border: 2px solid #00c853; position: relative;">
      <div style="font-weight: bold;">Agent Assist</div>
      <div style="font-size: 12px; opacity: 0.8;">Node</div>
    </div>
    <div style="font-size: 24px; color: #00c853;">→</div>
    <div style="background: #1a1a2e; color: white; padding: 20px 25px; border-radius: 12px; text-align: center; border: 2px solid #00c853;">
      <div style="font-weight: bold;">Agent Desktop</div>
      <div style="font-size: 12px; opacity: 0.8;">(Workflow UI)</div>
    </div>
  </div>
  <div style="font-size: 24px; color: #00c853; margin: 10px 0;">↓</div>
  <div style="background: linear-gradient(135deg, #00c853, #00a843); color: white; padding: 15px 30px; border-radius: 12px; text-align: center;">
    <div style="font-weight: bold;">LLM Analysis</div>
    <div style="font-size: 12px; opacity: 0.9;">(GPT-4o, Claude, Gemini)</div>
  </div>
</div>

`);

// Convert markdown to HTML
const htmlContent = marked(mdContent);

// Full HTML with styling
const fullHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    @page {
      margin: 40px;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      line-height: 1.6;
      max-width: 100%;
      margin: 0;
      padding: 20px 40px;
      color: #333;
      font-size: 14px;
    }
    h1 { 
      color: #00c853; 
      border-bottom: 3px solid #00c853; 
      padding-bottom: 15px;
      font-size: 28px;
    }
    h2 { 
      color: #1a1a2e; 
      margin-top: 35px;
      font-size: 22px;
      border-bottom: 1px solid #eee;
      padding-bottom: 8px;
    }
    h3 { 
      color: #333;
      font-size: 18px;
      margin-top: 25px;
    }
    h4 {
      color: #555;
      font-size: 16px;
    }
    table { 
      border-collapse: collapse; 
      width: 100%; 
      margin: 20px 0;
      font-size: 13px;
    }
    th, td { 
      border: 1px solid #ddd; 
      padding: 10px 12px; 
      text-align: left; 
    }
    th { 
      background-color: #00c853; 
      color: white;
      font-weight: 600;
    }
    tr:nth-child(even) { background-color: #f9f9f9; }
    code { 
      background-color: #f4f4f4; 
      padding: 2px 6px; 
      border-radius: 4px; 
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 13px;
    }
    pre { 
      background-color: #1a1a2e; 
      color: #e0e0e0; 
      padding: 20px; 
      border-radius: 8px; 
      overflow-x: auto;
      font-size: 12px;
      line-height: 1.5;
    }
    pre code { 
      background: none; 
      color: inherit;
      padding: 0;
    }
    img { 
      max-width: 100%; 
      height: auto; 
      border-radius: 4px; 
      margin: 20px 0;
      display: block;
    }
    blockquote { 
      border-left: 4px solid #00c853; 
      margin-left: 0; 
      padding-left: 20px; 
      color: #666;
      background: #f9f9f9;
      padding: 15px 20px;
      border-radius: 0 8px 8px 0;
    }
    hr { 
      border: none; 
      border-top: 2px solid #eee; 
      margin: 40px 0; 
    }
    ul, ol {
      padding-left: 25px;
    }
    li {
      margin-bottom: 8px;
    }
    strong {
      color: #1a1a2e;
    }
    /* Title page styling */
    div[align="center"] {
      page-break-after: always;
      padding-top: 150px;
    }
    div[align="center"] img {
      max-width: 300px;
    }
    /* Page break class */
    .page-break {
      page-break-after: always;
    }
    /* Make TOC links work */
    a {
      color: #00c853;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
${htmlContent}
</body>
</html>
`;

// Launch puppeteer and generate PDF
const browser = await puppeteer.launch({ headless: 'new' });
const page = await browser.newPage();
await page.setContent(fullHtml, { waitUntil: 'networkidle0' });
await page.pdf({
  path: './Agent-Assist-Workflows-Guide.pdf',
  format: 'A4',
  margin: { top: '50px', bottom: '50px', left: '50px', right: '50px' },
  printBackground: true,
});
await browser.close();

console.log('PDF generated successfully with embedded images!');
