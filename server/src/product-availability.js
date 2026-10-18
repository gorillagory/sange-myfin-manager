export const productIsActive = product => product?.active !== false;

export function preserveProductActive(input, currentProduct, update = false) {
  if (!update || Object.prototype.hasOwnProperty.call(input || {}, 'active')) return input;
  return { ...input, active: productIsActive(currentProduct) };
}

export async function unpublishInactiveProduct(c, companyId, product) {
  if (productIsActive(product)) return false;
  await c.query(
    'UPDATE myfin.storefront_products SET published=false,updated_at=now() WHERE company_id=$1 AND product_id=$2 AND published',
    [companyId, product.id],
  );
  await c.query(
    'UPDATE myfin.storefront_product_variants SET published=false WHERE company_id=$1 AND product_id=$2 AND published',
    [companyId, product.id],
  );
  return true;
}
