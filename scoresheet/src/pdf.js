import { jsPDF } from "jspdf";
import html2canvas from "html2canvas";

// One PDF page per set, landscape letter — the same capture-and-share
// pattern as Volley Bandit's print feature (see the main repo's CLAUDE.md,
// "Read this before touching print/PDF code"): share sheet where the
// browser can share a file, plain download where it can't or claims it can
// and then fails (Chrome on iOS).
export async function exportPdf(root, match) {
  if (!root) throw new Error("Nothing to print yet.");
  const pages = Array.from(root.querySelectorAll(".sheet-page"));
  if (!pages.length) throw new Error("No set has started yet.");
  // Score sheets are landscape; the libero tracking sheet (data-orient="p")
  // is portrait, like the MIAA form.
  const orient = (el) => (el.dataset.orient === "p" ? "p" : "l");
  const pdf = new jsPDF(orient(pages[0]), "pt", "letter");
  for (let i = 0; i < pages.length; i++) {
    const canvas = await html2canvas(pages[i], { scale: 2, backgroundColor: "#ffffff", logging: false });
    const img = canvas.toDataURL("image/jpeg", 0.92);
    if (i) pdf.addPage("letter", orient(pages[i]));
    const pw = pdf.internal.pageSize.getWidth();
    const ph = pdf.internal.pageSize.getHeight();
    const k = Math.min(pw / canvas.width, ph / canvas.height);
    const w = canvas.width * k;
    const h = canvas.height * k;
    pdf.addImage(img, "JPEG", (pw - w) / 2, (ph - h) / 2, w, h);
  }
  const h = match.header;
  const slug = (s) => String(s || "").trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  const filename = `scoresheet-${slug(h.visitor) || "visitor"}-at-${slug(h.home) || "home"}-${h.date || "match"}.pdf`;
  const blob = pdf.output("blob");
  const file = new File([blob], filename, { type: "application/pdf" });
  const download = () => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
    } catch (err) {
      if (err?.name !== "AbortError") download();
    }
  } else {
    download();
  }
  return filename;
}
