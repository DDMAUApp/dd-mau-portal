// DD Mau Build Sheet — what's IN every menu item.
//
// Sourced from the laminated cashier training pages (Andrew, May 2026).
// This is the kitchen + cashier reference for what each item is composed
// of: standard toppings, default sauce inclusion, piece counts for protein
// items, combo definitions.
//
// Different from menu.js (customer-facing prices + brief descriptions).
// Different from masterRecipes.js (cooking instructions).
// Different from M17 allergen matrix (allergen reference).
//
// Use this when a cashier or expo needs to know "what comes on this bowl?"
// or "how many shrimp in a banh mi?" without scrolling through three files.
//
// Schema:
//   { nameEn, nameEs?, baseEn?, baseEs?, standardToppings: [{en, es}],
//     notes: [{en, es}], piecesByProtein?: {proteinName: count} }

export const BUILD_SHEET_BOWLS = [
    {
        nameEn: "Vermicelli Bowl",
        nameEs: "Vermicelli Bowl",
        baseEn: "rice noodle base",
        baseEs: "base de fideos de arroz",
        standardToppings: [
            { en: "red cabbage", es: "repollo rojo" },
            { en: "lettuce", es: "lechuga" },
            { en: "cucumber", es: "pepinos" },
            { en: "pickled medley", es: "zanahoria (encurtido)" },
            { en: "cilantro", es: "cilantro" },
            { en: "fried shallots", es: "cebollas fritas" },
            { en: "crushed peanuts", es: "cacahuetes molidos" },
            { en: "scallions", es: "cebolla verde" },
        ],
        notes: [
            { en: "Comes with egg roll & choice of sauce.",
              es: "Viene con egg roll y elección de salsa." },
            { en: "Pork, chicken, beef, shrimp (8pcs), and combo bowls → Vietnamese egg roll (pork).",
              es: "Bowls de cerdo, pollo, res, camarón (8pz) y combo → egg roll vietnamita (cerdo)." },
            { en: "Tofu, vegan beef, vegan shrimp, veggie, and fish bowls → veggie egg roll (vegetarian).",
              es: "Bowls de tofu, carne vegana, camarón vegano, vegetal y pescado → egg roll vegetariano." },
            { en: "Combo bowl protein = chicken, pork, shrimp (2pcs), and steak.",
              es: "Combo bowl proteína = pollo, cerdo, camarón (2pz) y carne." },
            { en: "Allergy: omit crushed peanuts for peanut-allergic guests. Vinaigrette has fish sauce — sub Vegan Vinaigrette.",
              es: "Alergia: quita los cacahuates para clientes alérgicos. La vinagreta lleva pescado — usa Vinagreta Vegana." },
        ],
        piecesByProtein: { shrimp: 8, "shrimp (combo)": 2 },
    },
    {
        nameEn: "Salad Bowl",
        nameEs: "Salad Bowl",
        baseEn: "spring mix base",
        baseEs: "base de mezcla de hojas verdes",
        standardToppings: [
            { en: "red cabbage", es: "repollo rojo" },
            { en: "lettuce", es: "lechuga" },
            { en: "cucumber", es: "pepinos" },
            { en: "pickled medley", es: "zanahoria (encurtido)" },
            { en: "cilantro", es: "cilantro" },
            { en: "fried shallots", es: "cebollas fritas" },
            { en: "crushed peanuts", es: "cacahuetes molidos" },
            { en: "scallions", es: "cebolla verde" },
        ],
        notes: [
            { en: "Comes with egg roll & choice of sauce.",
              es: "Viene con egg roll y elección de salsa." },
            { en: "Same egg-roll rules as Vermicelli Bowl (pork variants → Vietnamese egg roll, others → veggie egg roll).",
              es: "Mismas reglas de egg roll que el Vermicelli Bowl." },
            { en: "Combo bowl protein = chicken, pork, shrimp (2pcs), and steak.",
              es: "Combo bowl proteína = pollo, cerdo, camarón (2pz) y carne." },
            { en: "Allergy: omit crushed peanuts for peanut-allergic guests. Vinaigrette has fish sauce — sub Vegan Vinaigrette.",
              es: "Alergia: quita los cacahuates. La vinagreta lleva pescado — usa Vinagreta Vegana." },
        ],
        piecesByProtein: { shrimp: 8, "shrimp (combo)": 2 },
    },
    {
        nameEn: "Rice Bowl",
        nameEs: "Rice Bowl",
        baseEn: "jasmine rice base",
        baseEs: "base de arroz jazmín",
        standardToppings: [
            { en: "red cabbage", es: "repollo rojo" },
            { en: "lettuce", es: "lechuga" },
            { en: "cucumber", es: "pepinos" },
            { en: "pickled medley", es: "zanahoria (encurtido)" },
            { en: "cilantro", es: "cilantro" },
            { en: "scallions", es: "cebolla verde" },
            { en: "egg (over easy)", es: "huevo (estrellado)" },
        ],
        notes: [
            { en: "Comes with an over-easy egg & choice of sauce.",
              es: "Viene con huevo estrellado y elección de salsa." },
            { en: "ASK vegan guests if they want the egg on the rice — it's the default.",
              es: "PREGUNTA a clientes veganos si quieren el huevo — viene por defecto." },
            { en: "No crushed peanuts on Rice Bowl by default.",
              es: "El Rice Bowl no lleva cacahuates molidos por defecto." },
        ],
    },
];

export const BUILD_SHEET_HANDHELDS = [
    {
        nameEn: "Bao Sliders (steam flour buns)",
        nameEs: "Bao Sliders (pan al vapor)",
        baseEn: "2 pieces per order",
        baseEs: "2 piezas por orden",
        standardToppings: [
            { en: "red cabbage", es: "repollo rojo" },
            { en: "pickled medley", es: "zanahoria (encurtido)" },
            { en: "cilantro", es: "cilantro" },
        ],
        notes: [
            { en: "Comes with choice of sauce.", es: "Viene con elección de salsa." },
            { en: "Shrimp bao = TWO shrimp per bao (4 total per order).",
              es: "Bao de camarón = DOS camarones por bao (4 total por orden)." },
            { en: "Bao bun CONTAINS DAIRY (milk in the dough).",
              es: "El pan bao CONTIENE LÁCTEO (leche en la masa)." },
        ],
        piecesByProtein: { "shrimp per bao": 2 },
    },
    {
        nameEn: "Spring Rolls (rice paper)",
        nameEs: "Spring Rolls (papel de arroz)",
        baseEn: "2 pieces per order",
        baseEs: "2 piezas por orden",
        standardToppings: [
            { en: "vermicelli noodles", es: "fideos vermicelli" },
            { en: "red cabbage", es: "repollo rojo" },
            { en: "lettuce", es: "lechuga" },
            { en: "cucumber", es: "pepinos" },
        ],
        notes: [
            { en: "Comes with choice of sauce — peanut sauce is OPTIONAL, not default.",
              es: "Viene con elección de salsa — la salsa de cacahuate es OPCIONAL, no viene por defecto." },
            { en: "Shrimp spring roll = THREE shrimp per spring roll (6 total per order).",
              es: "Spring roll de camarón = TRES camarones por spring roll (6 total por orden)." },
            { en: "Gluten-free (rice paper wrapper).", es: "Sin gluten (papel de arroz)." },
        ],
        piecesByProtein: { "shrimp per spring roll": 3 },
    },
    {
        nameEn: "Banh Mi (Vietnamese baguette)",
        nameEs: "Banh Mi (baguette vietnamita)",
        standardToppings: [
            { en: "pickled medley", es: "zanahoria (encurtido)" },
            { en: "cucumber", es: "pepinos" },
            { en: "cilantro", es: "cilantro" },
            { en: "jalapeños", es: "jalapeños" },
        ],
        notes: [
            { en: "DOES NOT come with sauce.", es: "NO viene con salsa." },
            { en: "Shrimp banh mi = 8 shrimp.", es: "Banh mi de camarón = 8 camarones." },
            { en: "Baguette = WHEAT. Mayo on most variants = EGG.",
              es: "Baguette = TRIGO. La mayonesa en la mayoría = HUEVO." },
        ],
        piecesByProtein: { shrimp: 8 },
    },
    {
        nameEn: "Tacos (roti shells)",
        nameEs: "Tacos (tortillas roti)",
        baseEn: "2 pieces per order",
        baseEs: "2 piezas por orden",
        standardToppings: [
            { en: "red cabbage", es: "repollo rojo" },
            { en: "pickled medley", es: "zanahoria (encurtido)" },
            { en: "cilantro", es: "cilantro" },
            { en: "jalapeño", es: "jalapeño" },
        ],
        notes: [
            { en: "Comes with choice of sauce.", es: "Viene con elección de salsa." },
            { en: "Shrimp taco = 4 shrimp per taco (8 total per order).",
              es: "Taco de camarón = 4 camarones por taco (8 total por orden)." },
            { en: "Roti shell = WHEAT.", es: "Tortilla roti = TRIGO." },
        ],
        piecesByProtein: { "shrimp per taco": 4 },
    },
];

export const BUILD_SHEET_FRIED_RICE = {
    nameEn: "Fried Rice",
    nameEs: "Arroz Frito",
    standardToppings: [
        { en: "scallions", es: "cebolla verde" },
        { en: "white onion", es: "cebolla blanca" },
        { en: "eggs", es: "huevos" },
    ],
    notes: [
        { en: "Combo Fried Rice = pork, ham, chicken, steak, & shrimp (different from bowls — bowls combo has no ham).",
          es: "Combo Fried Rice = cerdo, jamón, pollo, carne y camarón (diferente del bowl combo — el combo del bowl no lleva jamón)." },
        { en: "Veggie Fried Rice = cabbage, carrots, broccoli, beansprouts.",
          es: "Veggie Fried Rice = repollo, zanahorias, brócoli, germinados." },
        { en: "Shrimp variants = 8 shrimp.", es: "Variantes con camarón = 8 camarones." },
        { en: "Default contains EGG. Request 'no egg' for vegan.", es: "Por defecto lleva HUEVO. Pide 'sin huevo' para vegano." },
    ],
    piecesByProtein: { shrimp: 8 },
};

export const BUILD_SHEET_PHO = {
    nameEn: "Pho (Vietnamese noodle soup)",
    nameEs: "Pho (sopa de fideos vietnamita)",
    standardToppings: [
        { en: "scallions", es: "cebolla verde" },
        { en: "cilantro", es: "cilantro" },
        { en: "white onion", es: "cebolla blanca" },
        { en: "garnish plate (Thai basil, beansprouts, lime)", es: "plato de guarnición (albahaca tailandesa, germinados, lima)" },
    ],
    broths: [
        {
            nameEn: "Beef Broth",
            nameEs: "Caldo de Res",
            proteinsEn: [
                "Combo = brisket + rare steak + meatball",
                "Rare Steak: flank meat",
                "Brisket",
                "Meatball",
                "Seafood: shrimp, imitation crab, scallops, squid",
                "Shrimp",
                "Tofu and Veggies: broccoli, carrots, cabbage",
            ],
            proteinsEs: [
                "Combo = pecho + bistec + albóndiga",
                "Bistec poco cocido: carne de flanco",
                "Pecho (brisket)",
                "Albóndiga",
                "Mariscos: camarón, cangrejo de imitación, vieiras, calamar",
                "Camarón",
                "Tofu y verduras: brócoli, zanahoria, repollo",
            ],
        },
        {
            nameEn: "Chicken Broth",
            nameEs: "Caldo de Pollo",
            proteinsEn: ["Chicken"],
            proteinsEs: ["Pollo"],
        },
        {
            nameEn: "Vegan Broth",
            nameEs: "Caldo Vegano",
            proteinsEn: [
                "Vegan: tofu, cabbage, carrots, broccoli",
                "Spicy Vegan Lemongrass: deep-fried tofu, king mushroom, oyster mushroom",
            ],
            proteinsEs: [
                "Vegano: tofu, repollo, zanahoria, brócoli",
                "Vegano Picante con Hierba Limón: tofu frito, hongo king, hongo ostra",
            ],
        },
    ],
};

export const BUILD_SHEET_SAUCES = [
    { nameEn: "Vietnamese Vinaigrette",      nameEs: "Vinagreta Vietnamita",       descEn: "Traditional fish sauce",        descEs: "Salsa de pescado tradicional" },
    { nameEn: "Vegan Vietnamese Vinaigrette", nameEs: "Vinagreta Vietnamita Vegana", descEn: "Vegan fish sauce",              descEs: "Salsa de pescado vegana" },
    { nameEn: "Sweet Chili",                  nameEs: "Sweet Chili",                 descEn: "Sweet and sour sauce",          descEs: "Salsa agridulce" },
    { nameEn: "Peanut Dressing",              nameEs: "Peanut Dressing",             descEn: "Peanut sauce",                  descEs: "Salsa de cacahuate" },
    { nameEn: "Spicy Peanut Dressing",        nameEs: "Spicy Peanut Dressing",       descEn: "Peanut sauce with a kick",      descEs: "Salsa de cacahuate con picante" },
    { nameEn: "DD Dressing",                  nameEs: "Aderezo DD",                  descEn: "Creamy white sauce",            descEs: "Salsa blanca cremosa" },
    { nameEn: "Spicy DD",                     nameEs: "Spicy DD",                    descEn: "Creamy sriracha sauce",         descEs: "Salsa cremosa de sriracha" },
    { nameEn: "Hoisin",                       nameEs: "Hoisin",                      descEn: "Dark thick soy sauce",          descEs: "Salsa de soya oscura y espesa" },
];

export const BUILD_SHEET_SNACKS = [
    { nameEn: "Krab Rangoons",         nameEs: "Krab Rangoons",         descEn: "Deep-fried cream cheese dumpling",          descEs: "Empanadilla frita de queso crema" },
    { nameEn: "Thai Chili Pepper Wings", nameEs: "Thai Chili Pepper Wings", descEn: "Spicy dry-rub wings",                   descEs: "Alitas con sazón seco picante" },
    { nameEn: "Fried Shrimp Rolls",    nameEs: "Fried Shrimp Rolls",    descEn: "3 pieces of fried shrimp",                  descEs: "3 piezas de camarón frito" },
    { nameEn: "Vegan Cheese Rolls",    nameEs: "Vegan Cheese Rolls",    descEn: "Like a crab rangoon but with almond cream cheese", descEs: "Como crab rangoon pero con queso crema de almendra" },
    { nameEn: "Veggie Egg Rolls",      nameEs: "Veggie Egg Rolls",      descEn: "Cabbage, carrots, bean thread noodles, white onion, green onion", descEs: "Repollo, zanahorias, fideos de frijol, cebolla blanca, cebolla verde" },
    { nameEn: "Vietnamese Egg Rolls",  nameEs: "Vietnamese Egg Rolls",  descEn: "Pork, cabbage, carrots, bean thread noodles, white onion", descEs: "Cerdo, repollo, zanahorias, fideos de frijol, cebolla blanca" },
];
