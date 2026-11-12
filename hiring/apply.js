const $ = (id) => document.getElementById(id);
const form = $("apply-form");
const notice = (message) => {
  $("form-notice").textContent = message;
  $("form-notice").hidden = !message;
};
function fieldError(name, message) {
  $(`${name}-error`).textContent = message || "";
  $(name).setAttribute("aria-invalid", message ? "true" : "false");
}
function renderFile() {
  const file = $("resume").files[0];
  $("file-row").hidden = !file;
  $("file-name").textContent = file
    ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`
    : "";
  fieldError(
    "resume",
    file && (!/\.pdf$/i.test(file.name) || file.size > 5 * 1024 * 1024)
      ? "Choose a PDF no larger than 5 MB."
      : "",
  );
}
$("resume").addEventListener("change", renderFile);
$("remove-file").addEventListener("click", () => {
  $("resume").value = "";
  renderFile();
});
for (const event of ["dragover", "dragleave", "drop"])
  $("upload-zone").addEventListener(event, (e) => {
    e.preventDefault();
    $("upload-zone").classList.toggle("drag", event === "dragover");
    if (event === "drop" && !$("application-fields").disabled) {
      if (e.dataTransfer.files.length !== 1)
        return fieldError("resume", "Choose one PDF résumé.");
      $("resume").files = e.dataTransfer.files;
      renderFile();
    }
  });
async function loadRoles() {
  try {
    const response = await fetch("/api/positions");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    $("role-count").textContent =
      `${data.positions.length} open ${data.positions.length === 1 ? "role" : "roles"}`;
    $("positions-state").hidden = !!data.positions.length;
    $("positions-state").textContent =
      "We don’t have any open positions right now, but we’d still like to hear from you. Send us a general application below.";
    for (const role of data.positions) {
      const option = new Option(role.title, role.id);
      $("role").add(option);
      const card = document.createElement("article");
      card.className = "card";
      const title = document.createElement("h3");
      title.textContent = role.title;
      const meta = document.createElement("p");
      meta.className = "meta";
      meta.textContent = `${role.location} · ${role.type}`;
      const description = document.createElement("p");
      description.className = "description";
      description.textContent = role.description;
      const button = document.createElement("button");
      button.className = "button secondary";
      button.type = "button";
      button.textContent = "Apply for this role ↗";
      button.addEventListener("click", () => {
        $("role").value = role.id;
        $("application-form").scrollIntoView({ behavior: "smooth" });
        $("name").focus({ preventScroll: true });
      });
      card.append(title, meta, description, button);
      $("positions").append(card);
    }
    $("application-fields").disabled = false;
  } catch {
    $("role-count").textContent = "Unavailable";
    $("positions-state").textContent =
      "Opportunities are temporarily unavailable. Please try again later.";
    notice(
      "Applications are temporarily unavailable. Please try again later or contact Rahul@srijanlabs.in.",
    );
  }
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  notice("");
  for (const name of ["name", "email", "phone", "role", "resume"])
    fieldError(name, "");
  if (!form.reportValidity()) return;
  const file = $("resume").files[0];
  if (!file || !/\.pdf$/i.test(file.name) || file.size > 5 * 1024 * 1024) {
    fieldError("resume", "Choose a PDF no larger than 5 MB.");
    $("resume").focus();
    return;
  }
  const body = new FormData(form);
  $("application-fields").disabled = true;
  $("submit-application").textContent = "Submitting…";
  try {
    const response = await fetch("/api/applications", { method: "POST", body });
    const data = await response.json();
    if (!response.ok) {
      for (const [name, message] of Object.entries(data.fields || {}))
        fieldError(name, message);
      throw new Error(data.error || "Unable to submit. Please try again.");
    }
    form.hidden = true;
    $("success").hidden = false;
    $("success-message").textContent =
      `Thank you, ${data.name}. Your application for ${data.roleTitle} has been received. We’ll contact you if your profile matches what we’re looking for.`;
    $("reference").textContent = `Reference: ${data.id}`;
    $("success").focus();
    form.reset();
  } catch (error) {
    notice(error.message || "Unable to submit. Please try again.");
  } finally {
    $("application-fields").disabled = false;
    $("submit-application").textContent = "Submit application ↗";
    const invalid = form.querySelector('[aria-invalid="true"]');
    if (invalid) invalid.focus();
  }
});
loadRoles();
