export function useProductLogic() {
    /**
     * Generates a random SKU based on the category prefix.
     * Example: Retail -> RET-A2B3C4D5
     */
    function generateSKU(category) {
        if (!category) return '';
        const prefix = category.substring(0, 3).toUpperCase();
        const rand = crypto.randomUUID().slice(0,8).toUpperCase();
        return `${prefix}-${rand}`;
    }

    return { generateSKU };
}