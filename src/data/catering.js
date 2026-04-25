export const CATERING_MENU = [
    {
        category: "Finger Food",
        categoryEs: "Bocadillos",
        emoji: "🥟",
        items: [
            {
                name: "Crab Rangoons",
                nameEs: "Crab Rangoons",
                sizes: [
                    { label: "15 PCS", price: 23.99 },
                    { label: "30 PCS", price: 43.99 },
                    { label: "60 PCS", price: 84.99 }
                ],
                note: "Served w/ Sweet Chili Sauce",
                noteEs: "Servido con Salsa de Chile Dulce",
                hasSauces: false,
                hasProteins: false
            },
            {
                name: "Vietnamese/Vegetarian Egg Rolls",
                nameEs: "Rollos de Huevo Vietnamitas/Vegetarianos",
                sizes: [
                    { label: "20 Halves", price: 27.99 },
                    { label: "40 Halves", price: 41.99 },
                    { label: "60 Halves", price: 53.90 }
                ],
                typeOptions: ["Vietnamese", "Vegetarian"],
                typeOptionsEs: ["Vietnamitas", "Vegetarianos"],
                singleSauceOptions: ["Vietnamese Vinaigrette", "Sweet Chili"],
                singleSauceOptionsEs: ["Vinagreta Vietnamita", "Chile Dulce"],
                hasSauces: false,
                hasProteins: false
            },
            {
                name: "Spring Rolls",
                nameEs: "Rollos de Primavera",
                sizes: [
                    { label: "16 PCS", price: 92.99, sauceCount: 2, proteinCount: 2 },
                    { label: "32 PCS", price: 177.99, sauceCount: 3, proteinCount: 3 },
                    { label: "48 PCS", price: 246.99, sauceCount: 4, proteinCount: 4 }
                ],
                hasSauces: true,
                hasProteins: true
            },
            {
                name: "Bao Sliders",
                nameEs: "Mini Baos",
                sizes: [
                    { label: "12 PCS", price: 77.99, sauceCount: 2, proteinCount: 2 },
                    { label: "24 PCS", price: 130.99, sauceCount: 3, proteinCount: 3 },
                    { label: "36 PCS", price: 192.99, sauceCount: 4, proteinCount: 4 }
                ],
                hasSauces: true,
                hasProteins: true
            },
            {
                name: "Banh Mi",
                nameEs: "Bánh Mì",
                sizes: [
                    { label: "12 PCS", price: 77.99, proteinCount: 2 },
                    { label: "24 PCS", price: 154.99, proteinCount: 3 },
                    { label: "36 PCS", price: 223.99, proteinCount: 4 }
                ],
                hasSauces: false,
                hasProteins: true
            }
        ]
    },
    {
        category: "Fork & Knife Trays",
        categoryEs: "Bandejas con Cubiertos",
        emoji: "🍴",
        items: [
            {
                name: "Tray — Chicken, Pork, or Tofu",
                nameEs: "Bandeja — Pollo, Puerco o Tofu",
                sizes: [
                    { label: "Serves 6-8", price: 146.99 },
                    { label: "Serves 10-12", price: 223.99 }
                ],
                proteinOptions: ["Chicken", "Pork", "Tofu"],
                proteinOptionsEs: ["Pollo", "Puerco", "Tofu"],
                hasBase: true,
                hasSauces: true,
                sauceCount: 3,
                hasProteins: false,
                hasUtensils: true
            },
            {
                name: "Tray — Steak, Shrimp, Veggie, or Vegan Beef",
                nameEs: "Bandeja — Res, Camarón, Vegetal o Res Vegana",
                sizes: [
                    { label: "Serves 6-8", price: 161.99 },
                    { label: "Serves 10-12", price: 246.99 }
                ],
                proteinOptions: ["Steak", "Shrimp", "Veggie", "Vegan Beef"],
                proteinOptionsEs: ["Res", "Camarón", "Vegetal", "Res Vegana"],
                hasBase: true,
                hasSauces: true,
                sauceCount: 3,
                hasProteins: false,
                hasUtensils: true
            }
        ]
    },
    {
        category: "Mini Bowls",
        categoryEs: "Mini Tazones",
        emoji: "🥢",
        items: [
            {
                name: "Mini Bowls — Chicken, Pork, or Tofu",
                nameEs: "Mini Tazones — Pollo, Puerco o Tofu",
                sizes: [
                    { label: "10 Bowls", price: 130.99 },
                    { label: "20 Bowls", price: 254.99 }
                ],
                proteinOptions: ["Chicken", "Pork", "Tofu"],
                proteinOptionsEs: ["Pollo", "Puerco", "Tofu"],
                hasBase: true,
                hasSauces: true,
                sauceCount: 3,
                hasProteins: false,
                hasUtensils: true
            },
            {
                name: "Mini Bowls — Steak, Shrimp, Veggie, or Vegan Beef",
                nameEs: "Mini Tazones — Res, Camarón, Vegetal o Res Vegana",
                sizes: [
                    { label: "10 Bowls", price: 146.99 },
                    { label: "20 Bowls", price: 284.99 }
                ],
                proteinOptions: ["Steak", "Shrimp", "Veggie", "Vegan Beef"],
                proteinOptionsEs: ["Res", "Camarón", "Vegetal", "Res Vegana"],
                hasBase: true,
                hasSauces: true,
                sauceCount: 3,
                hasProteins: false,
                hasUtensils: true
            }
        ]
    },
    {
        category: "Fried Rice Trays",
        categoryEs: "Bandejas de Arroz Frito",
        emoji: "🍚",
        items: [
            {
                name: "Fried Rice — Plain",
                nameEs: "Arroz Frito — Solo",
                sizes: [
                    { label: "Serves 6-8", price: 61.99 },
                    { label: "Serves 10-12", price: 107.99 }
                ],
                note: "Eggs, Scallions, and White Onions",
                noteEs: "Huevos, Cebollín y Cebolla Blanca",
                hasSauces: false,
                hasProteins: false,
                hasUtensils: true
            },
            {
                name: "Fried Rice — Chicken, Pork, or Tofu",
                nameEs: "Arroz Frito — Pollo, Puerco o Tofu",
                sizes: [
                    { label: "Serves 6-8", price: 77.99 },
                    { label: "Serves 10-12", price: 138.99 }
                ],
                note: "Eggs, Scallions, and White Onions",
                noteEs: "Huevos, Cebollín y Cebolla Blanca",
                proteinOptions: ["Chicken", "Pork", "Tofu"],
                proteinOptionsEs: ["Pollo", "Puerco", "Tofu"],
                hasSauces: false,
                hasProteins: false,
                hasUtensils: true
            },
            {
                name: "Fried Rice — Steak, Shrimp, Veggie, or Vegan Beef",
                nameEs: "Arroz Frito — Res, Camarón, Vegetal o Res Vegana",
                sizes: [
                    { label: "Serves 6-8", price: 92.99 },
                    { label: "Serves 10-12", price: 169.99 }
                ],
                note: "Eggs, Scallions, and White Onions",
                noteEs: "Huevos, Cebollín y Cebolla Blanca",
                proteinOptions: ["Steak", "Shrimp", "Veggie", "Vegan Beef"],
                proteinOptionsEs: ["Res", "Camarón", "Vegetal", "Res Vegana"],
                hasSauces: false,
                hasProteins: false,
                hasUtensils: true
            }
        ]
    },
    {
        category: "DD Mau Sampler",
        categoryEs: "Muestra DD Mau",
        emoji: "🎉",
        items: [
            {
                name: "DD Mau Sampler",
                nameEs: "Muestra DD Mau",
                sizes: [
                    { label: "Serves 4-6", price: 154.99 }
                ],
                note: "6 Banh Mi Bites, 4 Mini Vermicelli Bowls, 8 Rice Paper Roll Halves, 10 Egg Roll Halves. Cutlery & napkins included.",
                noteEs: "6 Banh Mi, 4 Mini Tazones de Fideos, 8 Mitades de Rollos de Arroz, 10 Mitades de Rollos de Huevo. Cubiertos y servilletas incluidos.",
                hasSauces: true,
                sauceCount: 2,
                hasProteins: false,
                isSampler: true,
                samplerPicks: [
                    { name: "Banh Mi Bites (6 pcs)", nameEs: "Banh Mi (6 pzas)", count: 3 },
                    { name: "Mini Vermicelli Bowls (4)", nameEs: "Mini Tazones de Fideos (4)", count: 2 },
                    { name: "Rice Paper Rolls (8 halves)", nameEs: "Rollos de Arroz (8 mitades)", count: 2 }
                ],
                samplerEggRollType: true
            }
        ]
    }
];

export const ALL_SAUCES = ["Vietnamese Vinaigrette", "Peanut", "Hoisin", "Sweet Chili", "DD", "Spicy DD"];
export const ALL_SAUCES_ES = ["Vinagreta Vietnamita", "Cacahuate", "Hoisin", "Chile Dulce", "DD", "DD Picante"];
export const ALL_PROTEINS = ["Steak", "Shrimp", "Chicken", "Pork", "Tofu"];
export const ALL_PROTEINS_ES = ["Res", "Camarón", "Pollo", "Puerco", "Tofu"];
export const BASE_OPTIONS = ["Vermicelli", "Salad", "Rice"];
export const BASE_OPTIONS_ES = ["Fideos", "Ensalada", "Arroz"];
