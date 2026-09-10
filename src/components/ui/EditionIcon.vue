<script setup>
defineProps({ name: { type: String, default: 'grid' } });
const paths = {
 trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
 building:'M4 21V3h12v18M16 9h4v12M2 21h20M8 7h4M8 11h4M8 15h4M9 21v-3h3v3',
 mail:'M3 5h18v14H3zM3 6l9 7 9-7', pin:'M19 10c0 5-7 12-7 12S5 15 5 10a7 7 0 1 1 14 0ZM12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
 phone:'M5 3h4l2 5-3 2c2 3 3 4 6 6l2-3 5 2v4c0 2-3 3-7 1C8 18 3 13 2 7c0-2 1-4 3-4Z',
 image:'M3 3h18v18H3zM3 17l6-6 5 5 3-3 4 4M15 7h.01', percent:'M4 20 20 4M7 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM17 13a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
 qr:'M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h3v3h3v3h-6v-6ZM12 3v9H3M12 15v6M15 12h6',
 truck:'M2 5h12v12H2zM14 9h4l4 5v3h-8M5 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM18 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
 folder:'M3 8V4h6l3 3h9v3M3 8l-1 12h18l2-10H3', spark:'m12 3 2 6 7 3-7 2-2 7-2-7-7-2 7-3 2-6Z',
 'arrow-left':'M20 12H4m6-6-6 6 6 6','arrow-up':'M12 20V4m-6 6 6-6 6 6',
 grid:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
 bag:'M5 7h14l1 14H4L5 7ZM9 8V6a3 3 0 0 1 6 0v2',
 receipt:'M6 3h12v18l-3-2-3 2-3-2-3 2V3ZM9 7h6M9 11h6M9 15h3',
 box:'m3 7 9-4 9 4v10l-9 4-9-4V7Zm0 0 9 4 9-4M12 11v10M7.5 5 17 9',
 people:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM22 21v-2a4 4 0 0 0-3-3.87',
 wallet:'M20 8V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v12H5a3 3 0 0 1-3-3V6M20 13h-5v4h5',
 settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
 chart:'M4 3v18h17M8 16l4-5 4 2 5-7', clock:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v5l3 2',
 search:'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM16 16l5 5',
 plus:'M12 5v14M5 12h14', minus:'M5 12h14', close:'M6 6l12 12M18 6 6 18',
 arrow:'M4 12h16m-6-6 6 6-6 6', down:'m6 9 6 6 6-6',
 check:'m5 12 4 4L19 6', printer:'M6 8V3h12v5M6 17H3V9h18v8h-3M6 14h12v7H6zM17 11h1',
 card:'M2 5h20v14H2zM2 9h20M6 15h3',
 shield:'m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Zm-4 10 3 3 5-6',
 menu:'M3 6h18M3 12h18M3 18h18', logout:'M9 3H3v18h6M9 12h12m-5-5 5 5-5 5',
 cloud:'M7 18a5 5 0 1 1 0-10 6 6 0 0 1 11-2 6 6 0 0 1 0 12H7Zm2-6 3 3 4-5',
 alert:'m12 3 10 18H2L12 3ZM12 9v5M12 17h.01', edit:'m16 3 5 5-12 12H4v-5L16 3ZM13 6l5 5',
 download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5'
};
</script>
<template><svg class="ed-icon" viewBox="0 0 24 24" aria-hidden="true"><path :d="paths[name] || paths.grid" /></svg></template>
