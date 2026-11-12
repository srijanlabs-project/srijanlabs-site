const $ = (id) => document.getElementById(id);
let page = 1,
  editingId = null,
  requestVersion = 0;
const showMessage = (id, message) => {
  $(id).textContent = message;
  $(id).hidden = !message;
};
function signedOut(message = "") {
  $("dashboard").hidden = true;
  $("logout").hidden = true;
  $("login-panel").hidden = false;
  $("login-form").hidden = false;
  $("session-loading").hidden = true;
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  showMessage("login-message", message);
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && url !== "/api/admin/login")
      signedOut(data.error);
    throw new Error(data.error || "Something went wrong. Please try again.");
  }
  return data;
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
function action(label, callback, style = "secondary") {
  const button = element("button", label, `button ${style}`);
  button.type = "button";
  button.addEventListener("click", callback);
  return button;
}
async function dashboard() {
  $("login-panel").hidden = true;
  $("dashboard").hidden = false;
  $("logout").hidden = false;
  $("password").value = "";
  await Promise.all([loadApplications(), loadPositions()]);
}
async function loadApplications() {
  const version = ++requestVersion;
  try {
    const params = new URLSearchParams({
      q: $("search").value,
      role: $("filter-role").value,
      page,
    });
    const data = await api(`/api/admin/applications?${params}`);
    if (version !== requestVersion) return;
    if (page > 1 && !data.applications.length) {
      page--;
      return loadApplications();
    }
    const selection = $("filter-role").value;
    $("filter-role").replaceChildren(new Option("All roles", ""));
    for (const role of data.roles)
      $("filter-role").add(new Option(role.title, role.id));
    $("filter-role").value = selection;
    $("application-count").textContent =
      `${data.total} ${data.total === 1 ? "application" : "applications"} · Newest first`;
    $("applications-list").replaceChildren();
    if (!data.applications.length)
      $("applications-list").append(
        element(
          "div",
          $("search").value || selection
            ? "No matching applications. Try another search or role."
            : "No applications yet. New applications will appear here.",
          "empty",
        ),
      );
    else {
      const wrap = element("div", "", "table-wrap"),
        table = document.createElement("table"),
        head = document.createElement("thead"),
        row = document.createElement("tr");
      for (const title of [
        "Applicant",
        "Role",
        "Phone",
        "Received",
        "Action",
      ]) {
        const th = element("th", title);
        th.scope = "col";
        row.append(th);
      }
      head.append(row);
      table.append(head);
      const body = document.createElement("tbody");
      for (const item of data.applications) {
        const tr = document.createElement("tr"),
          who = document.createElement("td");
        who.append(
          element("strong", item.name),
          element("div", item.email, "muted"),
        );
        tr.append(
          who,
          element("td", item.roleTitle),
          element("td", item.phone),
          element("td", new Date(item.createdAt).toLocaleDateString()),
        );
        const cell = document.createElement("td");
        cell.append(action("View →", () => showApplication(item)));
        tr.append(cell);
        body.append(tr);
      }
      table.append(body);
      wrap.append(table);
      $("applications-list").append(wrap);
    }
    $("previous").disabled = page <= 1;
    $("next").disabled = page * 25 >= data.total;
    $("page-label").textContent =
      `Page ${page} of ${Math.max(1, Math.ceil(data.total / 25))}`;
  } catch (error) {
    showMessage("dashboard-notice", error.message);
  }
}
function showApplication(item) {
  $("detail-title").textContent = item.name;
  $("detail-list").replaceChildren();
  for (const [label, value] of Object.entries({
    Email: item.email,
    Phone: item.phone,
    Role: item.roleTitle,
    Received: new Date(item.createdAt).toLocaleString(),
    Reference: item.id,
  }))
    $("detail-list").append(element("dt", label), element("dd", value));
  $("download-resume").href = `/api/admin/applications/${item.id}/resume`;
  $("delete-application").onclick = () =>
    confirmDelete(
      "This permanently deletes the application and résumé. This cannot be undone.",
      async () => {
        await api(`/api/admin/applications/${item.id}`, { method: "DELETE" });
        $("detail-dialog").close();
        await loadApplications();
      },
    );
  $("detail-dialog").showModal();
}
async function loadPositions() {
  try {
    const data = await api("/api/admin/positions");
    $("positions-list").replaceChildren();
    if (!data.positions.length)
      $("positions-list").append(
        element(
          "div",
          "No positions yet. Add your first role, or keep accepting general applications.",
          "empty",
        ),
      );
    for (const role of data.positions) {
      const card = element("article", "", "card");
      card.append(
        element(
          "span",
          role.open ? "Open" : "Closed",
          `badge ${role.open ? "open" : ""}`,
        ),
        element("h3", role.title, "top-space"),
        element("p", `${role.location} · ${role.type}`, "meta"),
        element("p", role.description, "description"),
      );
      const actions = element("div", "", "actions");
      actions.append(
        action("Edit", () => editRole(role)),
        action(role.open ? "Close role" : "Open role", async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            await api(`/api/admin/positions/${role.id}`, {
              method: "PUT",
              body: JSON.stringify({ ...role, open: !role.open }),
            });
            await loadPositions();
          } catch (error) {
            showMessage("dashboard-notice", error.message);
          } finally {
            button.disabled = false;
          }
        }),
        action(
          "Delete",
          () =>
            confirmDelete(
              `Delete “${role.title}”? Applications already received for this role will be kept.`,
              async () => {
                await api(`/api/admin/positions/${role.id}`, {
                  method: "DELETE",
                });
                await loadPositions();
              },
            ),
          "danger",
        ),
      );
      card.append(actions);
      $("positions-list").append(card);
    }
  } catch (error) {
    showMessage("dashboard-notice", error.message);
  }
}
function editRole(role) {
  editingId = role?.id || null;
  $("role-dialog-title").textContent = role ? "Edit position" : "Add position";
  $("role-title").value = role?.title || "";
  $("role-location").value = role?.location || "";
  $("role-type").value = role?.type || "Full-time";
  $("role-description").value = role?.description || "";
  $("role-open").checked = role?.open ?? true;
  showMessage("role-error", "");
  $("role-dialog").showModal();
}
function confirmDelete(message, callback) {
  $("confirm-message").textContent = message;
  showMessage("confirm-error", "");
  $("confirm-dialog").showModal();
  $("confirm-delete").onclick = async () => {
    $("confirm-delete").disabled = true;
    try {
      await callback();
      $("confirm-dialog").close();
    } catch (error) {
      showMessage("confirm-error", error.message);
    } finally {
      $("confirm-delete").disabled = false;
    }
  };
}
$("role-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("save-role").disabled = true;
  showMessage("role-error", "");
  try {
    await api(`/api/admin/positions${editingId ? `/${editingId}` : ""}`, {
      method: editingId ? "PUT" : "POST",
      body: JSON.stringify({
        title: $("role-title").value,
        location: $("role-location").value,
        type: $("role-type").value,
        description: $("role-description").value,
        open: $("role-open").checked,
      }),
    });
    $("role-dialog").close();
    await loadPositions();
  } catch (error) {
    showMessage("role-error", error.message);
  } finally {
    $("save-role").disabled = false;
  }
});
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("login-button").disabled = true;
  showMessage("login-message", "");
  try {
    await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: $("password").value }),
    });
    await dashboard();
  } catch (error) {
    showMessage("login-message", error.message);
  } finally {
    $("login-button").disabled = false;
  }
});
$("show-password").onclick = () => {
  const show = $("password").type === "password";
  $("password").type = show ? "text" : "password";
  $("show-password").textContent = show ? "Hide" : "Show";
  $("show-password").setAttribute(
    "aria-label",
    show ? "Hide password" : "Show password",
  );
};
$("logout").onclick = async () => {
  try {
    await api("/api/admin/logout", { method: "POST" });
    signedOut();
  } catch (error) {
    showMessage("dashboard-notice", error.message);
  }
};
$("add-role").onclick = () => editRole();
document
  .querySelectorAll("[data-close]")
  .forEach(
    (button) => (button.onclick = () => $(button.dataset.close).close()),
  );
function tab(name) {
  for (const key of ["applications", "positions"]) {
    $(`${key}-tab`).setAttribute("aria-selected", key === name);
    $(`${key}-tab`).tabIndex = key === name ? 0 : -1;
    $(`${key}-panel`).hidden = key !== name;
  }
}
for (const key of ["applications", "positions"]) {
  $(`${key}-tab`).onclick = () => tab(key);
  $(`${key}-tab`).onkeydown = (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const target =
        event.key === "Home"
          ? "applications"
          : event.key === "End"
            ? "positions"
            : key === "applications"
              ? "positions"
              : "applications";
      tab(target);
      $(`${target}-tab`).focus();
    }
  };
}
let searchTimer;
$("search").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    page = 1;
    loadApplications();
  }, 250);
};
$("filter-role").onchange = () => {
  page = 1;
  loadApplications();
};
$("previous").onclick = () => {
  page--;
  loadApplications();
};
$("next").onclick = () => {
  page++;
  loadApplications();
};
(async () => {
  try {
    const session = await api("/api/admin/session");
    $("session-loading").hidden = true;
    if (!session.enabled) {
      showMessage(
        "login-message",
        "Admin access is not configured. Set an ADMIN_PASSWORD of at least 10 characters on the server.",
      );
      return;
    }
    if (session.authenticated) await dashboard();
    else signedOut();
  } catch (error) {
    signedOut(error.message);
  }
})();
