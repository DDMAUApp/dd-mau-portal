import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { doc, getDoc, setDoc, collection, getDocs } from 'firebase/firestore';

export default function InsuranceEnrollment({ language, staffName, staffList }) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [existingData, setExistingData] = useState(null);
  const [step, setStep] = useState(1);
  const [showAdmin, setShowAdmin] = useState(false);
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [allEnrollments, setAllEnrollments] = useState([]);
  const [loadingAll, setLoadingAll] = useState(false);
  const [selectedEnrollment, setSelectedEnrollment] = useState(null);

  const ADMIN_PIN = "ZhongGuo87";
  const isAdmin = staffName && ["andrew shih", "julie truong"].includes(staffName.toLowerCase());

  const handleAdminAccess = () => {
    const entered = prompt("Enter admin password:");
    if (entered === ADMIN_PIN) {
      setAdminUnlocked(true);
      setShowAdmin(true);
      loadAllEnrollments();
    } else if (entered !== null) {
      alert("Incorrect password.");
    }
  };

  // Form state
  const [form, setForm] = useState({
    legalFirstName: "",
    legalLastName: "",
    dateOfBirth: "",
    ssn4: "",
    gender: "",
    maritalStatus: "",
    phone: "",
    email: "",
    address: "",
    city: "",
    state: "MO",
    zip: "",
    hoursPerWeek: "",
    hasCurrentInsurance: "",
    desiredEffectiveDate: "",
    enrollMedical: false,
    enrollDental: false,
    enrollVision: false,
    enrollLife: false,
    medicalPlan: "",
    dentalPlan: "",
    visionPlan: "",
    lifePlan: "",
    coverageTier: "employee",
    dependents: [],
    signature: "",
    signatureDate: "",
    agreedToTerms: false,
  });

  // Load existing enrollment if any
  useEffect(() => {
    async function loadExisting() {
      try {
        const docRef = doc(db, "insurance", staffName.toLowerCase().replace(/\s+/g, "_"));
        const snap = await getDoc(docRef);
        if (snap.exists()) {
          const data = snap.data();
          setExistingData(data);
          setForm(prev => ({ ...prev, ...data.formData }));
        }
      } catch (err) {
        console.error("Error loading insurance data:", err);
      }
      setLoading(false);
    }
    loadExisting();
  }, [staffName]);

  const updateField = (field, value) => {
    setForm(prev => ({ ...prev, [field]: value }));
  };

  const addDependent = () => {
    setForm(prev => ({
      ...prev,
      dependents: [...prev.dependents, { name: "", dob: "", relationship: "", ssn4: "" }]
    }));
  };

  const updateDependent = (index, field, value) => {
    setForm(prev => {
      const deps = [...prev.dependents];
      deps[index] = { ...deps[index], [field]: value };
      return { ...prev, dependents: deps };
    });
  };

  const removeDependent = (index) => {
    setForm(prev => ({
      ...prev,
      dependents: prev.dependents.filter((_, i) => i !== index)
    }));
  };

  const handleSubmit = async () => {
    if (!form.agreedToTerms || !form.signature) return;
    setSubmitting(true);
    try {
      const docId = staffName.toLowerCase().replace(/\s+/g, "_");
      const now = new Date();
      await setDoc(doc(db, "insurance", docId), {
        staffName,
        formData: form,
        status: "pending_review",
        submittedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      setSubmitted(true);
      setExistingData({ status: "pending_review", submittedAt: now.toISOString() });
    } catch (err) {
      console.error("Error submitting enrollment:", err);
      alert(language === "es" ? "Error al enviar" : "Error submitting form");
    }
    setSubmitting(false);
  };

  // Admin: load all enrollments
  const loadAllEnrollments = async () => {
    setLoadingAll(true);
    try {
      const snap = await getDocs(collection(db, "insurance"));
      const list = [];
      snap.forEach(d => list.push({ id: d.id, ...d.data() }));
      list.sort((a, b) => (a.staffName || "").localeCompare(b.staffName || ""));
      setAllEnrollments(list);
    } catch (err) {
      console.error("Error loading enrollments:", err);
    }
    setLoadingAll(false);
  };

  // Load SheetJS from CDN
  const loadSheetJS = () => {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
      script.onload = () => resolve(window.XLSX);
      script.onerror = () => reject(new Error("Failed to load SheetJS"));
      document.head.appendChild(script);
    });
  };

  // Helper: build row array from one enrollment
  const enrollmentToRow = (e) => {
    const f = e.formData || {};
    const deps = (f.dependents || []).map(d => `${d.name} (${d.relationship})`).join("; ");
    return [
      e.staffName, e.status, e.submittedAt ? new Date(e.submittedAt).toLocaleDateString() : "",
      f.legalFirstName || "", f.legalLastName || "", f.dateOfBirth || "", f.ssn4 || "",
      f.gender || "", f.maritalStatus || "", f.hoursPerWeek || "", f.hasCurrentInsurance || "",
      f.desiredEffectiveDate || "", f.phone || "", f.email || "",
      f.address || "", f.city || "", f.state || "", f.zip || "",
      f.enrollMedical ? "Yes" : "No", f.medicalPlan || "",
      f.enrollDental ? "Yes" : "No", f.dentalPlan || "",
      f.enrollVision ? "Yes" : "No", f.visionPlan || "",
      f.enrollLife ? "Yes" : "No", f.lifePlan || "",
      f.coverageTier || "", deps, f.signature || "", f.signatureDate || ""
    ];
  };

  const EXCEL_HEADERS = [
    "Employee","Status","Submitted","Legal First","Legal Last","DOB","SSN (last 4)","Gender",
    "Marital Status","Hours/Week","Current Insurance","Effective Date","Phone","Email","Address","City","State","ZIP",
    "Medical","Medical Plan","Dental","Dental Plan","Vision","Vision Plan","Life","Life Plan",
    "Coverage Tier","Dependents","Signature","Signature Date"
  ];

  // Style and download a workbook
  const downloadWorkbook = (XLSX, wb, filename) => {
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Export all enrollments to Excel
  const exportAllExcel = async () => {
    try {
      const XLSX = await loadSheetJS();
      const data = [EXCEL_HEADERS, ...allEnrollments.map(enrollmentToRow)];
      const ws = XLSX.utils.aoa_to_sheet(data);
      // Auto-fit column widths
      ws["!cols"] = EXCEL_HEADERS.map((h, i) => ({
        wch: Math.max(h.length, ...allEnrollments.map(e => String(enrollmentToRow(e)[i] || "").length).concat([10]))
      }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "All Enrollments");
      downloadWorkbook(XLSX, wb, `DD_Mau_Insurance_All_${new Date().toISOString().split("T")[0]}.xlsx`);
    } catch (err) {
      console.error("Excel export error:", err);
      alert("Error exporting Excel. Please try again.");
    }
  };

  // Export single employee enrollment to Excel
  const exportSingleExcel = async (enrollment) => {
    try {
      const XLSX = await loadSheetJS();
      const f = enrollment.formData || {};
      // Build label-value pairs for a clean single-employee sheet
      const rows = [
        ["DD Mau — Insurance Enrollment"],
        [],
        ["Employee", enrollment.staffName],
        ["Status", enrollment.status],
        ["Submitted", enrollment.submittedAt ? new Date(enrollment.submittedAt).toLocaleDateString() : "—"],
        [],
        ["— Personal Information —"],
        ["Legal First Name", f.legalFirstName || ""],
        ["Legal Last Name", f.legalLastName || ""],
        ["Date of Birth", f.dateOfBirth || ""],
        ["SSN (last 4)", f.ssn4 || ""],
        ["Gender", f.gender || ""],
        ["Marital Status", f.maritalStatus || ""],
        ["Hours Per Week", f.hoursPerWeek || ""],
        ["Current Insurance", f.hasCurrentInsurance || ""],
        ["Desired Effective Date", f.desiredEffectiveDate || ""],
        [],
        ["— Contact Information —"],
        ["Phone", f.phone || ""],
        ["Email", f.email || ""],
        ["Address", f.address || ""],
        ["City", f.city || ""],
        ["State", f.state || ""],
        ["ZIP", f.zip || ""],
        [],
        ["— Coverage Selection —"],
        ["Medical", f.enrollMedical ? "Yes" : "No"],
        ["Medical Plan", f.medicalPlan || "—"],
        ["Dental", f.enrollDental ? "Yes" : "No"],
        ["Dental Plan", f.dentalPlan || "—"],
        ["Vision", f.enrollVision ? "Yes" : "No"],
        ["Vision Plan", f.visionPlan || "—"],
        ["Life Insurance", f.enrollLife ? "Yes" : "No"],
        ["Life Plan", f.lifePlan || "—"],
        ["Coverage Tier", f.coverageTier || ""],
        [],
        ["— Dependents —"],
      ];
      if ((f.dependents || []).length > 0) {
        rows.push(["Name", "Relationship", "DOB", "SSN (last 4)"]);
        (f.dependents || []).forEach(d => {
          rows.push([d.name || "", d.relationship || "", d.dob || "", d.ssn4 || ""]);
        });
      } else {
        rows.push(["None"]);
      }
      rows.push([]);
      rows.push(["— Signature —"]);
      rows.push(["Signature", f.signature || ""]);
      rows.push(["Date", f.signatureDate || ""]);

      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws["!cols"] = [{ wch: 22 }, { wch: 30 }, { wch: 16 }, { wch: 14 }];
      const wb = XLSX.utils.book_new();
      const safeName = (enrollment.staffName || "employee").replace(/[^a-zA-Z0-9 ]/g, "").slice(0, 25);
      XLSX.utils.book_append_sheet(wb, ws, safeName);
      downloadWorkbook(XLSX, wb, `DD_Mau_Insurance_${safeName.replace(/\s+/g, "_")}_${new Date().toISOString().split("T")[0]}.xlsx`);
    } catch (err) {
      console.error("Excel export error:", err);
      alert("Error exporting Excel. Please try again.");
    }
  };

  // Print individual enrollment
  const printEnrollment = (enrollment) => {
    const f = enrollment.formData || {};
    const deps = (f.dependents || []).map(d =>
      `<tr><td>${d.name}</td><td>${d.relationship}</td><td>${d.dob}</td><td>***${d.ssn4}</td></tr>`
    ).join("");
    const html = `<!DOCTYPE html><html><head><title>Insurance Enrollment - ${enrollment.staffName}</title>
    <style>body{font-family:Arial,sans-serif;max-width:700px;margin:20px auto;font-size:14px}
    h1{color:#0d9488;font-size:20px;border-bottom:2px solid #0d9488;padding-bottom:8px}
    h2{font-size:14px;color:#555;margin-top:20px;text-transform:uppercase;letter-spacing:1px}
    .row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #eee}
    .label{color:#888}.val{font-weight:bold}
    table{width:100%;border-collapse:collapse;margin-top:8px}
    th,td{text-align:left;padding:4px 8px;border:1px solid #ddd;font-size:12px}
    th{background:#f5f5f5}
    .sig{margin-top:30px;border-top:2px solid #333;padding-top:10px}
    .status{display:inline-block;padding:4px 12px;border-radius:12px;font-size:12px;font-weight:bold}
    @media print{body{margin:0}}</style></head><body>
    <h1>DD Mau - Insurance Enrollment Form</h1>
    <div class="row"><span class="label">Employee</span><span class="val">${enrollment.staffName}</span></div>
    <div class="row"><span class="label">Status</span><span class="val">${enrollment.status}</span></div>
    <div class="row"><span class="label">Submitted</span><span class="val">${enrollment.submittedAt ? new Date(enrollment.submittedAt).toLocaleDateString() : "—"}</span></div>
    <h2>Personal Information</h2>
    <div class="row"><span class="label">Legal Name</span><span class="val">${f.legalFirstName} ${f.legalLastName}</span></div>
    <div class="row"><span class="label">Date of Birth</span><span class="val">${f.dateOfBirth || "—"}</span></div>
    <div class="row"><span class="label">SSN (last 4)</span><span class="val">***${f.ssn4 || "—"}</span></div>
    <div class="row"><span class="label">Gender</span><span class="val">${f.gender || "—"}</span></div>
    <div class="row"><span class="label">Marital Status</span><span class="val">${f.maritalStatus || "—"}</span></div>
    <div class="row"><span class="label">Hours Per Week</span><span class="val">${f.hoursPerWeek || "—"}</span></div>
    <div class="row"><span class="label">Current Insurance</span><span class="val">${f.hasCurrentInsurance || "—"}</span></div>
    <div class="row"><span class="label">Desired Effective Date</span><span class="val">${f.desiredEffectiveDate || "—"}</span></div>
    <h2>Contact Information</h2>
    <div class="row"><span class="label">Phone</span><span class="val">${f.phone || "—"}</span></div>
    <div class="row"><span class="label">Email</span><span class="val">${f.email || "—"}</span></div>
    <div class="row"><span class="label">Address</span><span class="val">${f.address || ""}, ${f.city || ""}, ${f.state || ""} ${f.zip || ""}</span></div>
    <h2>Coverage Selection</h2>
    <div class="row"><span class="label">Medical</span><span class="val">${f.enrollMedical ? "Yes — " + (f.medicalPlan || "") : "No"}</span></div>
    <div class="row"><span class="label">Dental</span><span class="val">${f.enrollDental ? "Yes — " + (f.dentalPlan || "") : "No"}</span></div>
    <div class="row"><span class="label">Vision</span><span class="val">${f.enrollVision ? "Yes — " + (f.visionPlan || "") : "No"}</span></div>
    <div class="row"><span class="label">Life Insurance</span><span class="val">${f.enrollLife ? "Yes — " + (f.lifePlan || "") : "No"}</span></div>
    <div class="row"><span class="label">Coverage Tier</span><span class="val">${f.coverageTier || "—"}</span></div>
    ${(f.dependents || []).length > 0 ? `<h2>Dependents</h2><table><tr><th>Name</th><th>Relationship</th><th>DOB</th><th>SSN4</th></tr>${deps}</table>` : ""}
    <div class="sig">
    <div class="row"><span class="label">Signature</span><span class="val" style="font-style:italic">${f.signature || "—"}</span></div>
    <div class="row"><span class="label">Date</span><span class="val">${f.signatureDate || "—"}</span></div>
    </div></body></html>`;
    const win = window.open("", "_blank");
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 500);
  };

  // Admin: update enrollment status
  const updateEnrollmentStatus = async (enrollmentId, newStatus, note) => {
    try {
      await setDoc(doc(db, "insurance", enrollmentId), {
        status: newStatus,
        adminNote: note || "",
        updatedAt: new Date().toISOString(),
      }, { merge: true });
      setAllEnrollments(prev => prev.map(e =>
        e.id === enrollmentId ? { ...e, status: newStatus, adminNote: note || "" } : e
      ));
      setSelectedEnrollment(prev =>
        prev && prev.id === enrollmentId
          ? { ...prev, status: newStatus, adminNote: note || "", updatedAt: new Date().toISOString() }
          : prev
      );
    } catch (err) {
      console.error("Error updating status:", err);
    }
  };

  const L = (en, es) => language === "es" ? es : en;

  if (loading) {
    return (
      <div className="p-4 pb-24 text-center">
        <p className="text-gray-500 mt-8">{L("Loading...", "Cargando...")}</p>
      </div>
    );
  }

  // Show success state
  if (submitted) {
    return (
      <div className="p-4 pb-24">
        <div className="bg-green-50 border-2 border-green-300 rounded-xl p-6 text-center mt-4">
          <div className="text-5xl mb-3">✅</div>
          <h3 className="text-xl font-bold text-green-700 mb-2">
            {L("Enrollment Submitted!", "¡Inscripción Enviada!")}
          </h3>
          <p className="text-sm text-green-600">
            {L(
              "Your insurance enrollment has been submitted for review. You'll be notified once it's processed.",
              "Tu inscripción de seguro ha sido enviada para revisión. Se te notificará cuando sea procesada."
            )}
          </p>
        </div>
      </div>
    );
  }

  // Admin panel (must be checked before existingData so the button works)
  if (isAdmin && showAdmin && adminUnlocked) {
    return (
      <div className="p-4 pb-24">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-mint-700">
            📋 {L("Insurance Admin", "Admin de Seguro")}
          </h2>
          <button
            onClick={() => { setShowAdmin(false); setAdminUnlocked(false); }}
            className="text-xs font-bold text-gray-500 bg-gray-100 px-3 py-1 rounded-lg"
          >
            ← {L("Back", "Atrás")}
          </button>
        </div>

        {/* Export buttons */}
        <div className="flex gap-2 mb-4">
          <button
            onClick={exportAllExcel}
            disabled={allEnrollments.length === 0}
            className="flex-1 py-2 rounded-lg font-bold text-sm text-white bg-blue-600 hover:bg-blue-700 transition disabled:bg-gray-300"
          >
            📥 {L("Export All (Excel)", "Exportar Todo (Excel)")}
          </button>
          <button
            onClick={loadAllEnrollments}
            className="py-2 px-4 rounded-lg font-bold text-sm text-mint-700 bg-mint-50 border-2 border-mint-200 hover:bg-mint-100 transition"
          >
            🔄 {L("Refresh", "Actualizar")}
          </button>
        </div>

        {loadingAll && (
          <p className="text-sm text-gray-500 text-center py-4">{L("Loading enrollments...", "Cargando inscripciones...")}</p>
        )}

        {!loadingAll && allEnrollments.length === 0 && (
          <div className="text-center py-8">
            <p className="text-gray-400 text-sm">{L("No enrollments submitted yet.", "No hay inscripciones aún.")}</p>
            <button
              onClick={loadAllEnrollments}
              className="mt-3 text-sm font-bold text-mint-700 underline"
            >
              {L("Load enrollments", "Cargar inscripciones")}
            </button>
          </div>
        )}

        {/* Selected enrollment detail */}
        {selectedEnrollment && (
          <div className="bg-white border-2 border-mint-300 rounded-xl p-4 mb-4">
            <div className="flex justify-between items-start mb-3">
              <h3 className="font-bold text-lg text-gray-800">{selectedEnrollment.staffName}</h3>
              <button onClick={() => setSelectedEnrollment(null)} className="text-gray-400 text-lg font-bold">✕</button>
            </div>

            <div className="space-y-1 text-sm mb-3">
              <div className="flex justify-between">
                <span className="text-gray-500">{L("Name", "Nombre")}</span>
                <span className="font-bold">{selectedEnrollment.formData?.legalFirstName} {selectedEnrollment.formData?.legalLastName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">{L("Coverage", "Cobertura")}</span>
                <span className="font-bold">
                  {[
                    selectedEnrollment.formData?.enrollMedical && "Medical",
                    selectedEnrollment.formData?.enrollDental && "Dental",
                    selectedEnrollment.formData?.enrollVision && "Vision",
                    selectedEnrollment.formData?.enrollLife && "Life",
                  ].filter(Boolean).join(", ") || "None"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">{L("Tier", "Nivel")}</span>
                <span className="font-bold">{selectedEnrollment.formData?.coverageTier || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">{L("Dependents", "Dependientes")}</span>
                <span className="font-bold">{(selectedEnrollment.formData?.dependents || []).length}</span>
              </div>
            </div>

            <div className="flex gap-2 mb-3">
              <button
                onClick={() => exportSingleExcel(selectedEnrollment)}
                className="flex-1 py-2 rounded-lg text-xs font-bold text-green-700 bg-green-50 border border-green-200"
              >
                📥 {L("Excel", "Excel")}
              </button>
              <button
                onClick={() => printEnrollment(selectedEnrollment)}
                className="flex-1 py-2 rounded-lg text-xs font-bold text-blue-700 bg-blue-50 border border-blue-200"
              >
                🖨️ {L("Print / PDF", "Imprimir / PDF")}
              </button>
            </div>

            {/* Status actions */}
            <div className="border-t border-gray-200 pt-3">
              <p className="text-xs font-bold text-gray-500 mb-2">{L("Update Status", "Actualizar Estado")}</p>
              <div className="flex gap-2 flex-wrap">
                {[
                  { val: "approved", label: "✅ Approve", es: "✅ Aprobar", color: "bg-green-100 text-green-700" },
                  { val: "needs_update", label: "📝 Needs Update", es: "📝 Necesita Cambios", color: "bg-orange-100 text-orange-700" },
                  { val: "declined", label: "❌ Decline", es: "❌ Rechazar", color: "bg-red-100 text-red-700" },
                ].map(s => (
                  <button
                    key={s.val}
                    onClick={() => updateEnrollmentStatus(selectedEnrollment.id, s.val, "")}
                    className={`px-3 py-1 rounded-lg text-xs font-bold ${s.color} ${selectedEnrollment.status === s.val ? "ring-2 ring-offset-1 ring-gray-400" : ""}`}
                  >
                    {L(s.label, s.es)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Enrollment list */}
        {allEnrollments.length > 0 && (
          <div className="space-y-2">
            {allEnrollments.map(e => {
              const statusColors = {
                pending_review: "bg-yellow-100 text-yellow-700",
                approved: "bg-green-100 text-green-700",
                needs_update: "bg-orange-100 text-orange-700",
                declined: "bg-red-100 text-red-700",
              };
              const statusIcons = { pending_review: "⏳", approved: "✅", needs_update: "📝", declined: "❌" };
              return (
                <button
                  key={e.id}
                  onClick={() => setSelectedEnrollment(e)}
                  className={`w-full text-left bg-white border-2 rounded-xl p-3 flex items-center justify-between transition hover:border-mint-400 ${
                    selectedEnrollment?.id === e.id ? "border-mint-500" : "border-gray-200"
                  }`}
                >
                  <div>
                    <p className="font-bold text-sm text-gray-800">{e.staffName}</p>
                    <p className="text-xs text-gray-400">
                      {e.submittedAt ? new Date(e.submittedAt).toLocaleDateString() : "—"}
                    </p>
                  </div>
                  <span className={`text-xs font-bold px-2 py-1 rounded-full ${statusColors[e.status] || "bg-gray-100 text-gray-500"}`}>
                    {statusIcons[e.status] || "?"} {e.status?.replace("_", " ")}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // Show existing enrollment status
  if (existingData && !submitted) {
    const statusConfig = {
      pending_review: { color: "bg-yellow-100 text-yellow-700 border-yellow-300", icon: "⏳", label: L("Pending Review", "En Revisión") },
      approved: { color: "bg-green-100 text-green-700 border-green-300", icon: "✅", label: L("Approved", "Aprobado") },
      needs_update: { color: "bg-orange-100 text-orange-700 border-orange-300", icon: "📝", label: L("Needs Update", "Necesita Actualización") },
      declined: { color: "bg-red-100 text-red-700 border-red-300", icon: "❌", label: L("Declined", "Rechazado") },
    };
    const status = statusConfig[existingData.status] || statusConfig.pending_review;

    return (
      <div className="p-4 pb-24">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-2xl font-bold text-mint-700">
            🏥 {L("Insurance Enrollment", "Inscripción de Seguro")}
          </h2>
          {isAdmin && (
            <button
              onClick={handleAdminAccess}
              className="text-xs font-bold text-mint-700 bg-mint-50 px-3 py-1 rounded-lg border border-mint-200"
            >
              📋 Admin
            </button>
          )}
        </div>

        <div className={`${status.color} border-2 rounded-xl p-4 mb-4`}>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-2xl">{status.icon}</span>
            <span className="font-bold text-lg">{status.label}</span>
          </div>
          <p className="text-xs opacity-75">
            {L("Submitted", "Enviado")}: {new Date(existingData.submittedAt).toLocaleDateString()}
          </p>
          {existingData.adminNote && (
            <p className="text-sm mt-2">💬 {existingData.adminNote}</p>
          )}
        </div>

        {/* Summary of what was submitted */}
        <div className="bg-white rounded-xl border-2 border-gray-200 p-4 mb-4">
          <h3 className="text-sm font-bold text-gray-700 mb-3">{L("Your Enrollment Summary", "Resumen de tu Inscripción")}</h3>

          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">{L("Name", "Nombre")}</span>
              <span className="font-bold">{form.legalFirstName} {form.legalLastName}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">{L("Coverage", "Cobertura")}</span>
              <span className="font-bold">
                {[
                  form.enrollMedical && (L("Medical", "Médico")),
                  form.enrollDental && (L("Dental", "Dental")),
                  form.enrollVision && (L("Visión", "Visión")),
                  form.enrollLife && (L("Life", "Vida")),
                ].filter(Boolean).join(", ") || L("None selected", "Ninguna")}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">{L("Tier", "Nivel")}</span>
              <span className="font-bold">
                {{
                  employee: L("Employee Only", "Solo Empleado"),
                  employee_spouse: L("Employee + Spouse", "Empleado + Cónyuge"),
                  employee_children: L("Employee + Children", "Empleado + Hijos"),
                  family: L("Family", "Familia"),
                }[form.coverageTier]}
              </span>
            </div>
            {form.dependents.length > 0 && (
              <div className="flex justify-between">
                <span className="text-gray-500">{L("Dependents", "Dependientes")}</span>
                <span className="font-bold">{form.dependents.length}</span>
              </div>
            )}
          </div>
        </div>

        {(existingData.status === "needs_update" || existingData.status === "declined") && (
          <button
            onClick={() => { setExistingData(null); setStep(1); }}
            className="w-full py-3 rounded-lg font-bold text-white bg-mint-700 hover:bg-mint-800 transition"
          >
            📝 {L("Update Enrollment", "Actualizar Inscripción")}
          </button>
        )}
      </div>
    );
  }

  // Multi-step form
  const totalSteps = 4;
  const progressPercent = (step / totalSteps) * 100;

  return (
    <div className="p-4 pb-24">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-2xl font-bold text-mint-700">
          🏥 {L("Insurance Enrollment", "Inscripción de Seguro")}
        </h2>
        {isAdmin && (
          <button
            onClick={handleAdminAccess}
            className="text-xs font-bold text-mint-700 bg-mint-50 px-3 py-1 rounded-lg border border-mint-200"
          >
            📋 Admin
          </button>
        )}
      </div>
      <p className="text-xs text-gray-500 mb-4">
        {L("Complete all sections to enroll in benefits", "Completa todas las secciones para inscribirte en beneficios")}
      </p>

      {/* Progress bar */}
      <div className="mb-4">
        <div className="flex justify-between text-xs font-bold text-gray-500 mb-1">
          <span>{L("Step", "Paso")} {step} / {totalSteps}</span>
          <span>{Math.round(progressPercent)}%</span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div
            className="bg-mint-600 h-2 rounded-full transition-all duration-300"
            style={{ width: progressPercent + "%" }}
          />
        </div>
        <div className="flex justify-between mt-1">
          {[
            L("Personal", "Personal"),
            L("Contact", "Contacto"),
            L("Coverage", "Cobertura"),
            L("Review", "Revisar"),
          ].map((label, i) => (
            <span
              key={i}
              className={`text-[10px] font-bold ${i + 1 <= step ? "text-mint-700" : "text-gray-400"}`}
            >
              {label}
            </span>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl border-2 border-gray-200 p-4 space-y-4">

        {/* STEP 1: Personal Information */}
        {step === 1 && (
          <>
            <h3 className="text-sm font-bold text-mint-700 uppercase tracking-wide">
              {L("Personal Information", "Información Personal")}
            </h3>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-bold text-gray-600 block mb-1">
                  {L("Legal First Name", "Nombre Legal")} *
                </label>
                <input
                  type="text"
                  value={form.legalFirstName}
                  onChange={e => updateField("legalFirstName", e.target.value)}
                  className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-mint-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-xs font-bold text-gray-600 block mb-1">
                  {L("Legal Last Name", "Apellido Legal")} *
                </label>
                <input
                  type="text"
                  value={form.legalLastName}
                  onChange={e => updateField("legalLastName", e.target.value)}
                  className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-mint-500 focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="text-xs font-bold text-gray-600 block mb-1">
                {L("Date of Birth", "Fecha de Nacimiento")} *
              </label>
              <input
                type="date"
                value={form.dateOfBirth}
                onChange={e => updateField("dateOfBirth", e.target.value)}
                className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-mint-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="text-xs font-bold text-gray-600 block mb-1">
                {L("Last 4 of SSN", "Últimos 4 del SSN")} *
              </label>
              <input
                type="text"
                maxLength={4}
                inputMode="numeric"
                pattern="[0-9]*"
                value={form.ssn4}
                onChange={e => updateField("ssn4", e.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="••••"
                className="w-32 border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-mint-500 focus:outline-none tracking-widest"
              />
            </div>

            <div>
              <label className="text-xs font-bold text-gray-600 block mb-1">
                {L("Gender", "Género")}
              </label>
              <div className="flex gap-2">
                {[
                  { val: "male", en: "Male", es: "Masculino" },
                  { val: "female", en: "Female", es: "Femenino" },
                  { val: "other", en: "Other", es: "Otro" },
                ].map(g => (
                  <button
                    key={g.val}
                    onClick={() => updateField("gender", g.val)}
                    className={`flex-1 py-2 rounded-lg text-xs font-bold border-2 transition ${
                      form.gender === g.val
                        ? "bg-mint-700 text-white border-mint-700"
                        : "bg-gray-50 text-gray-600 border-gray-200"
                    }`}
                  >
                    {L(g.en, g.es)}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs font-bold text-gray-600 block mb-1">
                {L("Marital Status", "Estado Civil")}
              </label>
              <select
                value={form.maritalStatus}
                onChange={e => updateField("maritalStatus", e.target.value)}
                className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-mint-500 focus:outline-none"
              >
                <option value="">{L("Select...", "Seleccionar...")}</option>
                <option value="single">{L("Single", "Soltero/a")}</option>
                <option value="married">{L("Married", "Casado/a")}</option>
                <option value="domestic_partner">{L("Domestic Partner", "Pareja Doméstica")}</option>
                <option value="divorced">{L("Divorced", "Divorciado/a")}</option>
                <option value="widowed">{L("Widowed", "Viudo/a")}</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-bold text-gray-600 block mb-1">
                {L("Hours Worked Per Week", "Horas Trabajadas Por Semana")} *
              </label>
              <select
                value={form.hoursPerWeek}
                onChange={e => updateField("hoursPerWeek", e.target.value)}
                className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-mint-500 focus:outline-none"
              >
                <option value="">{L("Select...", "Seleccionar...")}</option>
                <option value="under_20">{L("Under 20 hours", "Menos de 20 horas")}</option>
                <option value="20_29">{L("20–29 hours", "20–29 horas")}</option>
                <option value="30_39">{L("30–39 hours", "30–39 horas")}</option>
                <option value="40_plus">{L("40+ hours", "40+ horas")}</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-bold text-gray-600 block mb-1">
                {L("Do you currently have health insurance?", "¿Tienes seguro médico actualmente?")} *
              </label>
              <div className="flex gap-2">
                {[
                  { val: "yes", en: "Yes", es: "Sí" },
                  { val: "no", en: "No", es: "No" },
                ].map(opt => (
                  <button
                    key={opt.val}
                    onClick={() => updateField("hasCurrentInsurance", opt.val)}
                    className={`flex-1 py-2 rounded-lg text-xs font-bold border-2 transition ${
                      form.hasCurrentInsurance === opt.val
                        ? "bg-mint-700 text-white border-mint-700"
                        : "bg-gray-50 text-gray-600 border-gray-200"
                    }`}
                  >
                    {L(opt.en, opt.es)}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs font-bold text-gray-600 block mb-1">
                {L("Desired Effective Date", "Fecha de Inicio Deseada")} *
              </label>
              <select
                value={form.desiredEffectiveDate}
                onChange={e => updateField("desiredEffectiveDate", e.target.value)}
                className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-mint-500 focus:outline-none"
              >
                <option value="">{L("Select month...", "Seleccionar mes...")}</option>
                <option value="2026-08">{L("August 2026", "Agosto 2026")}</option>
                <option value="2026-09">{L("September 2026", "Septiembre 2026")}</option>
                <option value="2026-10">{L("October 2026", "Octubre 2026")}</option>
                <option value="2026-11">{L("November 2026", "Noviembre 2026")}</option>
                <option value="2026-12">{L("December 2026", "Diciembre 2026")}</option>
                <option value="2027-01">{L("January 2027", "Enero 2027")}</option>
              </select>
            </div>
          </>
        )}

        {/* STEP 2: Contact Information */}
        {step === 2 && (
          <>
            <h3 className="text-sm font-bold text-mint-700 uppercase tracking-wide">
              {L("Contact Information", "Información de Contacto")}
            </h3>

            <div>
              <label className="text-xs font-bold text-gray-600 block mb-1">
                {L("Phone Number", "Número de Teléfono")} *
              </label>
              <input
                type="tel"
                value={form.phone}
                onChange={e => updateField("phone", e.target.value)}
                placeholder="(314) 555-0123"
                className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-mint-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="text-xs font-bold text-gray-600 block mb-1">
                {L("Email (optional)", "Correo Electrónico (opcional)")}
              </label>
              <input
                type="email"
                value={form.email}
                onChange={e => updateField("email", e.target.value)}
                placeholder="name@example.com"
                className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-mint-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="text-xs font-bold text-gray-600 block mb-1">
                {L("Home Address", "Dirección")} *
              </label>
              <input
                type="text"
                value={form.address}
                onChange={e => updateField("address", e.target.value)}
                placeholder={L("Street address", "Dirección")}
                className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-mint-500 focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-5 gap-2">
              <div className="col-span-2">
                <label className="text-xs font-bold text-gray-600 block mb-1">
                  {L("City", "Ciudad")} *
                </label>
                <input
                  type="text"
                  value={form.city}
                  onChange={e => updateField("city", e.target.value)}
                  className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-mint-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-xs font-bold text-gray-600 block mb-1">
                  {L("State", "Estado")}
                </label>
                <input
                  type="text"
                  maxLength={2}
                  value={form.state}
                  onChange={e => updateField("state", e.target.value.toUpperCase())}
                  className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-mint-500 focus:outline-none"
                />
              </div>
              <div className="col-span-2">
                <label className="text-xs font-bold text-gray-600 block mb-1">
                  {L("ZIP", "Código Postal")} *
                </label>
                <input
                  type="text"
                  maxLength={5}
                  inputMode="numeric"
                  value={form.zip}
                  onChange={e => updateField("zip", e.target.value.replace(/\D/g, "").slice(0, 5))}
                  className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-mint-500 focus:outline-none"
                />
              </div>
            </div>

          </>
        )}

        {/* STEP 3: Coverage Selection */}
        {step === 3 && (
          <>
            <h3 className="text-sm font-bold text-mint-700 uppercase tracking-wide">
              {L("Coverage Selection", "Selección de Cobertura")}
            </h3>

            <p className="text-xs text-gray-500">
              {L("Select the benefits you'd like to enroll in.", "Selecciona los beneficios en los que deseas inscribirte.")}
            </p>

            {/* Plan toggles */}
            {[
              { key: "enrollMedical", icon: "🏥", en: "Medical", es: "Médico", planKey: "medicalPlan",
                plans: [
                  { val: "basic", en: "Basic Plan", es: "Plan Básico", desc: L("Lower premium, higher deductible", "Prima más baja, deducible más alto") },
                  { val: "standard", en: "Standard Plan", es: "Plan Estándar", desc: L("Balanced coverage", "Cobertura equilibrada") },
                  { val: "premium", en: "Premium Plan", es: "Plan Premium", desc: L("Lower deductible, more coverage", "Deducible más bajo, más cobertura") },
                ]
              },
              { key: "enrollDental", icon: "🦷", en: "Dental", es: "Dental", planKey: "dentalPlan",
                plans: [
                  { val: "preventive", en: "Preventive", es: "Preventivo", desc: L("Cleanings & exams", "Limpiezas y exámenes") },
                  { val: "comprehensive", en: "Comprehensive", es: "Completo", desc: L("Full dental coverage", "Cobertura dental completa") },
                ]
              },
              { key: "enrollVision", icon: "👁️", en: "Vision", es: "Visión", planKey: "visionPlan",
                plans: [
                  { val: "basic", en: "Basic Vision", es: "Visión Básica", desc: L("Annual exam + frames", "Examen anual + marcos") },
                  { val: "premium", en: "Premium Vision", es: "Visión Premium", desc: L("Exam + frames + contacts", "Examen + marcos + contactos") },
                ]
              },
              { key: "enrollLife", icon: "🛡️", en: "Life Insurance", es: "Seguro de Vida", planKey: "lifePlan",
                plans: [
                  { val: "basic", en: "Basic ($25k)", es: "Básico ($25k)", desc: L("$25,000 coverage", "Cobertura de $25,000") },
                  { val: "standard", en: "Standard ($50k)", es: "Estándar ($50k)", desc: L("$50,000 coverage", "Cobertura de $50,000") },
                  { val: "premium", en: "Premium ($100k)", es: "Premium ($100k)", desc: L("$100,000 coverage", "Cobertura de $100,000") },
                ]
              },
            ].map(benefit => (
              <div key={benefit.key} className="border-2 border-gray-200 rounded-xl p-3">
                <button
                  onClick={() => updateField(benefit.key, !form[benefit.key])}
                  className="w-full flex items-center justify-between"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">{benefit.icon}</span>
                    <span className="font-bold text-gray-800">{L(benefit.en, benefit.es)}</span>
                  </div>
                  <div className={`w-12 h-7 rounded-full flex items-center transition-colors duration-200 ${
                    form[benefit.key] ? "bg-mint-600 justify-end" : "bg-gray-300 justify-start"
                  }`}>
                    <div className="w-5 h-5 bg-white rounded-full shadow mx-1" />
                  </div>
                </button>

                {form[benefit.key] && (
                  <div className="mt-3 space-y-2">
                    {benefit.plans.map(plan => (
                      <button
                        key={plan.val}
                        onClick={() => updateField(benefit.planKey, plan.val)}
                        className={`w-full text-left p-2 rounded-lg border-2 transition ${
                          form[benefit.planKey] === plan.val
                            ? "border-mint-500 bg-mint-50"
                            : "border-gray-200 hover:border-gray-300"
                        }`}
                      >
                        <p className="text-sm font-bold">{L(plan.en, plan.es)}</p>
                        <p className="text-xs text-gray-500">{plan.desc}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {/* Coverage tier */}
            <div>
              <label className="text-xs font-bold text-gray-600 uppercase tracking-wide block mb-2">
                {L("Coverage Tier", "Nivel de Cobertura")}
              </label>
              <div className="space-y-2">
                {[
                  { val: "employee", en: "Employee Only", es: "Solo Empleado", icon: "👤" },
                  { val: "employee_spouse", en: "Employee + Spouse", es: "Empleado + Cónyuge", icon: "👥" },
                  { val: "employee_children", en: "Employee + Child(ren)", es: "Empleado + Hijo(s)", icon: "👨‍👧" },
                  { val: "family", en: "Family", es: "Familia", icon: "👨‍👩‍👧‍👦" },
                ].map(tier => (
                  <button
                    key={tier.val}
                    onClick={() => updateField("coverageTier", tier.val)}
                    className={`w-full text-left p-3 rounded-lg border-2 flex items-center gap-3 transition ${
                      form.coverageTier === tier.val
                        ? "border-mint-500 bg-mint-50"
                        : "border-gray-200"
                    }`}
                  >
                    <span className="text-xl">{tier.icon}</span>
                    <span className={`font-bold text-sm ${form.coverageTier === tier.val ? "text-mint-700" : "text-gray-700"}`}>
                      {L(tier.en, tier.es)}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Dependents */}
            {form.coverageTier !== "employee" && (
              <div className="border-t-2 border-gray-100 pt-4">
                <div className="flex justify-between items-center mb-3">
                  <h4 className="text-xs font-bold text-gray-600 uppercase tracking-wide">
                    {L("Dependents", "Dependientes")}
                  </h4>
                  <button
                    onClick={addDependent}
                    className="text-xs font-bold text-mint-700 bg-mint-50 px-3 py-1 rounded-lg hover:bg-mint-100 transition"
                  >
                    + {L("Add", "Agregar")}
                  </button>
                </div>

                {form.dependents.length === 0 && (
                  <p className="text-xs text-gray-400 italic text-center py-2">
                    {L("No dependents added yet", "Sin dependientes aún")}
                  </p>
                )}

                {form.dependents.map((dep, i) => (
                  <div key={i} className="bg-gray-50 rounded-lg p-3 mb-2 relative">
                    <button
                      onClick={() => removeDependent(i)}
                      className="absolute top-2 right-2 text-red-400 hover:text-red-600 text-xs font-bold"
                    >
                      ✕
                    </button>
                    <p className="text-xs font-bold text-gray-500 mb-2">
                      {L("Dependent", "Dependiente")} {i + 1}
                    </p>
                    <div className="space-y-2">
                      <input
                        type="text"
                        value={dep.name}
                        onChange={e => updateDependent(i, "name", e.target.value)}
                        placeholder={L("Full name", "Nombre completo")}
                        className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-mint-500 focus:outline-none"
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          type="date"
                          value={dep.dob}
                          onChange={e => updateDependent(i, "dob", e.target.value)}
                          className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-mint-500 focus:outline-none"
                        />
                        <select
                          value={dep.relationship}
                          onChange={e => updateDependent(i, "relationship", e.target.value)}
                          className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-mint-500 focus:outline-none"
                        >
                          <option value="">{L("Relationship", "Relación")}</option>
                          <option value="spouse">{L("Spouse", "Cónyuge")}</option>
                          <option value="child">{L("Child", "Hijo/a")}</option>
                          <option value="domestic_partner">{L("Domestic Partner", "Pareja")}</option>
                        </select>
                      </div>
                      <input
                        type="text"
                        maxLength={4}
                        inputMode="numeric"
                        value={dep.ssn4}
                        onChange={e => updateDependent(i, "ssn4", e.target.value.replace(/\D/g, "").slice(0, 4))}
                        placeholder={L("Last 4 SSN", "Últimos 4 SSN")}
                        className="w-32 border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-mint-500 focus:outline-none"
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* STEP 4: Review & Sign */}
        {step === 4 && (
          <>
            <h3 className="text-sm font-bold text-mint-700 uppercase tracking-wide">
              {L("Review & Sign", "Revisar y Firmar")}
            </h3>

            {/* Summary */}
            <div className="bg-mint-50 rounded-lg p-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-600">{L("Name", "Nombre")}</span>
                <span className="font-bold">{form.legalFirstName} {form.legalLastName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">{L("DOB", "Fecha Nac.")}</span>
                <span className="font-bold">{form.dateOfBirth || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">{L("Hours/Week", "Horas/Semana")}</span>
                <span className="font-bold">
                  {{ under_20: L("Under 20", "Menos de 20"), "20_29": "20–29", "30_39": "30–39", "40_plus": "40+" }[form.hoursPerWeek] || "—"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">{L("Current Insurance", "Seguro Actual")}</span>
                <span className="font-bold">{form.hasCurrentInsurance === "yes" ? L("Yes", "Sí") : form.hasCurrentInsurance === "no" ? "No" : "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">{L("Effective Date", "Fecha de Inicio")}</span>
                <span className="font-bold">{form.desiredEffectiveDate || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">{L("Phone", "Teléfono")}</span>
                <span className="font-bold">{form.phone || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">{L("Address", "Dirección")}</span>
                <span className="font-bold text-right text-xs">{form.address}, {form.city}, {form.state} {form.zip}</span>
              </div>
              <hr className="border-mint-200" />
              <div className="flex justify-between">
                <span className="text-gray-600">{L("Medical", "Médico")}</span>
                <span className="font-bold">{form.enrollMedical ? (form.medicalPlan || "✓") : "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">{L("Dental", "Dental")}</span>
                <span className="font-bold">{form.enrollDental ? (form.dentalPlan || "✓") : "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">{L("Vision", "Visión")}</span>
                <span className="font-bold">{form.enrollVision ? (form.visionPlan || "✓") : "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">{L("Life", "Vida")}</span>
                <span className="font-bold">{form.enrollLife ? (form.lifePlan || "✓") : "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">{L("Tier", "Nivel")}</span>
                <span className="font-bold">
                  {{
                    employee: L("Employee Only", "Solo Empleado"),
                    employee_spouse: L("Employee + Spouse", "Empleado + Cónyuge"),
                    employee_children: L("Employee + Children", "Empleado + Hijos"),
                    family: L("Family", "Familia"),
                  }[form.coverageTier]}
                </span>
              </div>
              {form.dependents.length > 0 && (
                <div>
                  <span className="text-gray-600 text-xs">{L("Dependents", "Dependientes")}:</span>
                  {form.dependents.map((d, i) => (
                    <p key={i} className="text-xs font-bold ml-2">• {d.name} ({d.relationship})</p>
                  ))}
                </div>
              )}
            </div>

            {/* Signature */}
            <div className="border-t-2 border-gray-100 pt-4">
              <label className="text-xs font-bold text-gray-600 block mb-1">
                {L("Type your full legal name as signature", "Escribe tu nombre legal completo como firma")} *
              </label>
              <input
                type="text"
                value={form.signature}
                onChange={e => updateField("signature", e.target.value)}
                placeholder={L("Your full legal name", "Tu nombre legal completo")}
                className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-mint-500 focus:outline-none italic"
                style={{ fontFamily: "cursive" }}
              />
            </div>

            <div>
              <label className="text-xs font-bold text-gray-600 block mb-1">
                {L("Date", "Fecha")}
              </label>
              <input
                type="date"
                value={form.signatureDate || new Date().toISOString().split("T")[0]}
                onChange={e => updateField("signatureDate", e.target.value)}
                className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-mint-500 focus:outline-none"
              />
            </div>

            {/* Terms */}
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.agreedToTerms}
                onChange={e => updateField("agreedToTerms", e.target.checked)}
                className="mt-1 w-4 h-4 accent-mint-600"
              />
              <span className="text-xs text-gray-600 leading-tight">
                {L(
                  "I certify that the information provided is accurate and complete. I understand that false information may result in denial of coverage.",
                  "Certifico que la información proporcionada es precisa y completa. Entiendo que la información falsa puede resultar en la denegación de cobertura."
                )}
              </span>
            </label>
          </>
        )}
      </div>

      {/* Navigation Buttons */}
      <div className="flex gap-3 mt-4">
        {step > 1 && (
          <button
            onClick={() => setStep(step - 1)}
            className="flex-1 py-3 rounded-lg font-bold text-mint-700 bg-mint-50 border-2 border-mint-200 hover:bg-mint-100 transition"
          >
            ← {L("Back", "Atrás")}
          </button>
        )}

        {step < totalSteps ? (
          <button
            onClick={() => setStep(step + 1)}
            className="flex-1 py-3 rounded-lg font-bold text-white bg-mint-700 hover:bg-mint-800 transition"
          >
            {L("Next", "Siguiente")} →
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={submitting || !form.agreedToTerms || !form.signature}
            className={`flex-1 py-3 rounded-lg font-bold text-white text-lg transition ${
              submitting || !form.agreedToTerms || !form.signature
                ? "bg-gray-300 cursor-not-allowed"
                : "bg-mint-700 hover:bg-mint-800"
            }`}
          >
            {submitting
              ? (L("Submitting...", "Enviando..."))
              : (L("✅ Submit Enrollment", "✅ Enviar Inscripción"))
            }
          </button>
        )}
      </div>
    </div>
  );
}
