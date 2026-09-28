import multipart from "@fastify/multipart";
import { fileTypeFromBuffer } from "file-type";
import { constants } from "node:fs";
import { open, lstat, realpath, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { authorize, audit } from "./business.js";
import { parse, id, fail } from "./validation.js";
import { managementLock,managementSession } from "./management.js";
import { owner,requireCapability,recordVisible } from "./access.js";

export async function registerFiles(app, { database: db, uploadDir }) {
  const sessionGuard=async(c,req)=>{await managementLock(c);await managementSession(c,req);};
  const root = resolve(uploadDir);
  const stat = await lstat(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(root)) !== root
  )
    throw Error("unsafe_upload_directory");
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
  });
  app.post(
    "/api/companies/:company/files/:kind",
    { config: { rateLimit: { max: 20, timeWindow: 60000 } } },
    async (req) => {
      const company = parse(id, req.params.company),
        kind = req.params.kind;
      if (!["products", "receipts"].includes(kind))
        fail(400, "invalid_file_kind");
      // Authorize before consuming upload bytes and recheck inside metadata transaction.
      await db.transaction(async(c) => {await sessionGuard(c,req);await authorize(c, req.identity, company);requireCapability(req.identity,kind==="products"?"inventoryWrite":"expensesWrite");});
      const file = await req.file();
      if (!file) fail(400, "file_required");
      const bytes = await file.toBuffer();
      if (
        file.file.truncated ||
        bytes.length > (kind === "products" ? 3 : 5) * 1024 * 1024
      )
        fail(413, "file_too_large");
      const type = await fileTypeFromBuffer(bytes).catch(() => null);
      if (
        !type ||
        ![
          "image/jpeg",
          "image/png",
          "image/webp",
          ...(kind === "receipts" ? ["application/pdf"] : []),
        ].includes(type.mime)
      )
        fail(400, "unsupported_file");
      const fileId = randomUUID(),
        path = join(root, fileId);
      let created = false;
      try {
        const handle = await open(
          path,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            constants.O_NOFOLLOW,
          0o600,
        );
        created = true;
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await db.transaction(async (c) => {
          await sessionGuard(c,req);
          await authorize(c, req.identity, company);
          requireCapability(req.identity,kind==="products"?"inventoryWrite":"expensesWrite");
          await c.query(
            "INSERT INTO myfin.files(id,company_id,actor_id,kind,mime,size) VALUES($1,$2,$3,$4,$5,$6)",
            [fileId, company, req.identity.id, kind, type.mime, bytes.length],
          );
          await audit(c, req.identity, company, "Upload file", fileId);
        });
      } catch (error) {
        if (created) await unlink(path).catch(() => {});
        throw error;
      }
      return { url: `/api/files/${fileId}`, path: fileId };
    },
  );
  app.get("/api/files/:id", async (req, reply) => {
    const fileId = parse(id, req.params.id);
    const meta = await db.transaction(async (c) => {
      await sessionGuard(c,req);
      const r = await c.query("SELECT * FROM myfin.files WHERE id=$1", [
        fileId,
      ]);
      if (!r.rowCount) fail(404, "not_found");
      await authorize(c, req.identity, r.rows[0].company_id);
      if(!owner(req.identity)){
        const url="/api/files/"+fileId,co=r.rows[0].company_id;
        const expense=await c.query("SELECT 1 FROM myfin.expenses WHERE company_id=$1 AND (data->>'receiptPath'=$2 OR data->>'attachmentPath'=$2 OR data->>'receiptUrl'=$3 OR data->>'attachmentUrl'=$3) LIMIT 1",[co,fileId,url]);
        if(expense.rowCount)fail(403,"access_denied");
        const refs=await c.query("SELECT * FROM myfin.transactions WHERE company_id=$1 AND (data->>'receiptPath'=$2 OR data->>'attachmentPath'=$2 OR data->>'receiptUrl'=$3 OR data->>'attachmentUrl'=$3)",[co,fileId,url]);
        if(refs.rows.some(row=>!recordVisible(row,req.identity)))fail(403,"access_denied");
        if(r.rows[0].kind==="receipts"&&!refs.rows.some(row=>recordVisible(row,req.identity)))fail(403,"access_denied");
      }
      return r.rows[0];
    });
    const handle = await open(
      join(root, fileId),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    ).catch(() => fail(404, "not_found"));
    const st = await handle.stat();
    if (!st.isFile() || st.size !== meta.size) {
      await handle.close();
      fail(404, "not_found");
    }
    reply
      .header("Content-Type", meta.mime)
      .header("Content-Length", meta.size)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header(
        "Content-Disposition",
        `${meta.mime === "application/pdf" ? "attachment" : "inline"}; filename="${fileId}.${meta.mime.split("/")[1]}"`,
      );
    return reply.send(handle.createReadStream());
  });
  app.delete("/api/files/:id", async (req) => {
    const fileId = parse(id, req.params.id);
    await db.transaction(async (c) => {
      await sessionGuard(c,req);
      const r = await c.query(
        "SELECT * FROM myfin.files WHERE id=$1 FOR UPDATE",
        [fileId],
      );
      if (!r.rowCount) fail(404, "not_found");
      await authorize(c, req.identity, r.rows[0].company_id);
      requireCapability(req.identity,r.rows[0].kind==="products"?"inventoryWrite":"expensesWrite");
      if(!owner(req.identity)&&r.rows[0].actor_id!==req.identity.id)fail(403,"access_denied");
      for (const table of ["products", "expenses", "transactions"]) {
        const refs = await c.query(
          `SELECT id FROM myfin.${table} WHERE company_id=$1 AND (data->>'imagePath'=$2 OR data->>'receiptPath'=$2 OR data->>'attachmentPath'=$2 OR data->>'imageUrl'=$3 OR data->>'receiptUrl'=$3 OR data->>'attachmentUrl'=$3) LIMIT 1`,
          [r.rows[0].company_id, fileId, "/api/files/" + fileId],
        );
        if (refs.rowCount) fail(409, "file_is_referenced");
      }
      // Published document and paid receipt snapshots retain their original assets.
      const snapshots=await c.query("SELECT id FROM myfin.transactions WHERE company_id=$1 AND (jsonb_path_exists(data,'$.** ? (@ == $uri || @ == $path)',jsonb_build_object('uri',$3::text,'path',$2::text)) OR jsonb_path_exists(issued_snapshot,'$.** ? (@ == $uri || @ == $path)',jsonb_build_object('uri',$3::text,'path',$2::text))) LIMIT 1",[r.rows[0].company_id,fileId,"/api/files/"+fileId]);
      if(snapshots.rowCount)fail(409,"file_is_referenced");
      const companyRefs = await c.query("SELECT id FROM myfin.companies WHERE id=$1 AND (data->>'logo'=$2 OR data->>'qrCode'=$2 OR data->>'qrCodeUrl'=$2) LIMIT 1", [r.rows[0].company_id, "/api/files/" + fileId]);
      if (companyRefs.rowCount) fail(409, "file_is_referenced");
      await c.query("DELETE FROM myfin.files WHERE id=$1", [fileId]);
      await audit(c, req.identity, r.rows[0].company_id, "Delete file", fileId);
    });
    // A crash here can leave an inaccessible orphan, never public metadata pointing to missing bytes.
    await unlink(join(root, fileId)).catch(() => {});
    return { ok: true };
  });
}
