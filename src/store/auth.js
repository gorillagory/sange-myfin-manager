import { manageableAccount } from "../domain/viewAccess";
import { api } from "../services/api";
export const authModule = {
  init: (s) => s.init(),
  login: (s, e, p) => s.login(e, p),
  logout: (s) => s.logout(),
  fetchUserProfile: (s) => s.loadSession(),
  async addUser(s, u) {
    try {
      if (!s.can("usersManage") || (!s.can("managersManage") && (u.role !== "operator" || !(u.assignments||[]).every(x=>x.company_id===s.state.currentUser.company_id&&x.role==="operator")))) throw new Error("Your account can create operators in this company only.");
      await api("/users", {
        method: "POST",
        body: Object.fromEntries(
          Object.entries(u).filter(([k, value]) => !(k === "id" && !value)),
        ),
      });
      await s.startListeners();
      s.notify("User created.");
      return true;
    } catch (e) {
      s.notify(e.message, "error");
      return false;
    }
  },
  async updateUser(s, u) {
    try {
      const target = s.state.users.find(user => user.id === u.id);
      if (!target || !manageableAccount(s.state.currentUser,target) || (!s.can("managersManage") && (u.role !== "operator" || !(u.assignments||[]).every(x=>x.company_id===s.state.currentUser.company_id&&x.role==="operator")))) throw new Error("Your account can manage operators in this company only.");
      const { password, ...body } = u;
      if (body.disabled === undefined) {
        const current = s.state.users.find(user => user.id === u.id);
        if (current) body.disabled = !!current.disabled;
      }
      await api("/users/" + encodeURIComponent(u.id), { method: "PUT", body });
      await s.startListeners();
      return true;
    } catch (e) {
      s.notify(e.message, "error");
      return false;
    }
  },
  async deleteUser(s, id) {
    const target = s.state.users.find(user => user.id === id);
    if (!target || !manageableAccount(s.state.currentUser,target)) throw new Error("This account is outside your management scope.");
    await api("/users/" + encodeURIComponent(id), { method: "DELETE" });
    await s.startListeners();
  },
  async updateSelf(s, { username, password, currentPassword }) {
    try {
      if (password)
        await api("/auth/change-password", {
          method: "POST",
          body: {
            newPassword: password,
            currentPassword,
            revokeOtherSessions: true,
          },
        });
      await api("/me", { method: "PATCH", body: { username } });
      await s.loadSession();
      s.notify("Profile updated.");
      return true;
    } catch (e) {
      s.notify(e.message, "error");
      return false;
    }
  },
};
