let expired = () => {};
export const onSessionExpired = (fn) => {
  expired = fn;
};
export async function api(path, { method = "GET", body, ...options } = {}) {
  let response;
  try {
    response = await fetch("/api" + path, {
      ...options,
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers:
        body === undefined || body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" },
      ...(body === undefined
        ? {}
        : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    });
  } catch (error) {
    error.network = true;
    throw error;
  }
  const result = await response
    .json()
    .catch(() => ({ error: "Invalid server response" }));
  if (!response.ok) {
    if (response.status === 401) expired();
    const error = new Error(result.error || "Request failed");
    error.status = response.status;
    throw error;
  }
  return result;
}
export async function listAll(path) {
  const rows = [];
  let next = null;
  do {
    const page = await api(
      path + (next ? "?after=" + encodeURIComponent(next) : ""),
    );
    rows.push(...page.rows);
    next = page.next;
    if (rows.length > 50000)
      throw new Error(
        "Store exceeds the device catalog limit. Contact your administrator.",
      );
  } while (next);
  return rows;
}
export const companyPath = (store, suffix = "") => {
  const id = store.state.selectedCompany?.id;
  if (!id) throw new Error("Choose a store first.");
  return "/companies/" + encodeURIComponent(id) + suffix;
};
export async function writeRecord(store, name, data, update = false) {
  const path = companyPath(
    store,
    "/" + name + (update ? "/" + encodeURIComponent(data.id) : ""),
  );
  const result = await api(path, {
    method: update ? "PUT" : "POST",
    body: data,
  });
  await store.refreshData();
  return result;
}
export async function removeRecord(store, name, id) {
  await api(companyPath(store, "/" + name + "/" + encodeURIComponent(id)), {
    method: "DELETE",
  });
  await store.refreshData();
}
