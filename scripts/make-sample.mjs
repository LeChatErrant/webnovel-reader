// Generates a small, original multi-chapter EPUB at public/sample.epub.
// Used as the "Try a sample" book and for local verification. Original text,
// no third-party content. Run: node scripts/make-sample.mjs
import JSZip from "jszip";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const chapters = [
  {
    id: "c1",
    title: "Chapter 1: The Last Train",
    body: `<p>Rain hammered the empty station. Kael pulled his coat tighter and watched the last train slip into the dark, its lights swallowed one by one.</p>
<p>He had counted on being alone. The platform said otherwise — a single figure at the far end, motionless, hood drawn against the cold.</p>
<p>For a moment neither of them moved. Then the stranger raised a hand, palm open, and the air between them seemed to <em>thin</em>.</p>
<p>Kael let out a slow breath. Whatever waited in the tunnels tonight, it had already found him first.</p>
<p>He thought of the note in his pocket, the one signed only with a <strong>single black feather</strong>, and understood that turning back had stopped being a choice hours ago.</p>`,
  },
  {
    id: "c2",
    title: "Chapter 2: Beneath the City",
    body: `<p>The tunnel smelled of iron and old water. Every dozen paces a lamp guttered, throwing shadows that leaned the wrong way.</p>
<p>"You came," the stranger said. Not a question. "Most don't."</p>
<p>Kael counted the exits out of habit. There were none. "You said you knew what happened to my sister."</p>
<p>The stranger's smile did not reach the dark beneath the hood. "I said I knew where she went. Knowing what happened is a different price entirely."</p>
<hr/>
<p>They walked a long time. The city above became a rumor, then a memory, then nothing at all.</p>`,
  },
  {
    id: "c3",
    title: "Chapter 3: The Feather Market",
    body: `<p>The cavern opened without warning, vast and lit by a thousand hanging lanterns that burned without flame.</p>
<p>Stalls lined every path. They sold things Kael had no words for: bottled arguments, borrowed years, the particular quiet that follows bad news.</p>
<p>"Keep your hands in your pockets," the stranger murmured. "And whatever you're offered — do not agree out loud."</p>
<p>At the market's heart stood a woman selling feathers, each one black as the note in Kael's pocket. She looked up as he approached, and she had his sister's eyes.</p>`,
  },
  {
    id: "c4",
    title: "Chapter 4: A Fair Price",
    body: `<p>"You're late," she said, in a voice that was almost right and therefore worse than wrong.</p>
<p>Kael's throat tightened. "You're not her."</p>
<p>"No," the woman agreed, pleasantly. "But I remember her. I remember everyone who passes through. Memory is the only currency that never runs out down here."</p>
<p>She held out a feather. "One truth for one truth. You tell me why you really came, and I'll tell you which door she took."</p>
<p>Behind him, the stranger had gone very still. Above him, somewhere impossibly far, the last train was pulling into a station with no one left to meet it.</p>
<p>Kael reached for the feather.</p>`,
  },
];

const zip = new JSZip();

// mimetype must be first and stored (uncompressed) — added with compression:"STORE".
zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

zip.file(
  "META-INF/container.xml",
  `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
);

const manifestItems = chapters
  .map((c) => `    <item id="${c.id}" href="${c.id}.xhtml" media-type="application/xhtml+xml"/>`)
  .join("\n");
const spineItems = chapters.map((c) => `    <itemref idref="${c.id}"/>`).join("\n");

zip.file(
  "OEBPS/content.opf",
  `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:sample-webnovel-reader-0001</dc:identifier>
    <dc:title>The Last Train (Sample)</dc:title>
    <dc:creator>Webnovel Reader</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
${manifestItems}
  </manifest>
  <spine toc="ncx">
${spineItems}
  </spine>
</package>`
);

const navList = chapters
  .map((c) => `      <li><a href="${c.id}.xhtml">${c.title}</a></li>`)
  .join("\n");
zip.file(
  "OEBPS/nav.xhtml",
  `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
${navList}
    </ol>
  </nav>
</body>
</html>`
);

const navPoints = chapters
  .map(
    (c, i) => `    <navPoint id="np${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${c.title}</text></navLabel>
      <content src="${c.id}.xhtml"/>
    </navPoint>`
  )
  .join("\n");
zip.file(
  "OEBPS/toc.ncx",
  `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:sample-webnovel-reader-0001"/></head>
  <docTitle><text>The Last Train (Sample)</text></docTitle>
  <navMap>
${navPoints}
  </navMap>
</ncx>`
);

for (const c of chapters) {
  zip.file(
    `OEBPS/${c.id}.xhtml`,
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${c.title}</title></head>
<body>
  <h1>${c.title}</h1>
${c.body}
</body>
</html>`
  );
}

const buf = await zip.generateAsync({ type: "nodebuffer" });
mkdirSync(join(root, "public"), { recursive: true });
writeFileSync(join(root, "public", "sample.epub"), buf);
console.log("Wrote public/sample.epub (" + buf.length + " bytes)");
