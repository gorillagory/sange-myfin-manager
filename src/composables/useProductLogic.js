export function useProductLogic() {
    /**
     * Generates a random SKU based on the category prefix.
     * Example: Retail -> RET-8392
     */
    function generateSKU(category) {
        if (!category) return '';
        const prefix = category.substring(0, 3).toUpperCase();
        const rand = Math.floor(1000 + Math.random() * 9000);
        return `${prefix}-${rand}`;
    }

    return { generateSKU };
}