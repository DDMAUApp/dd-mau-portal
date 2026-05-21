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

// Andrew 2026-05-20: "i want to add one section at the very top of
// the date sticker page. put in all the bowls protiens. then above
// the fried rice add all the fried rice protein and then all the
// pho proteins". Each list is the set of proteins that get
// prepped-in-batch for that category, suitable for printing a
// date sticker per container.
//
// Note on overlap: chicken / pork / shrimp / tofu show up across
// categories because the kitchen preps them once and they serve
// multiple categories (a single lemongrass-chicken batch goes on
// bowls, banh mi, lo mein, fried rice). Andrew asked for three
// separate sections; the overlap is intentional — staff sees what
// each category needs in its own column.

// Andrew 2026-05-20: "yes everything on the list" — add Rice &
// Noodles + Stocks + Made Ahead. Same edit machinery as the
// proteins/sauces/snacks — each section appears in STICKER_SECTIONS
// and is rendered by BuildSheetFlatSection.

export const BUILD_SHEET_RICE_NOODLES = [
    { nameEn: "Jasmine Rice",            nameEs: "Arroz Jazmín",                  descEn: "Rice Bowl base / Fried Rice base",                          descEs: "Base de Rice Bowl / Fried Rice" },
    { nameEn: "Brown Rice",              nameEs: "Arroz Integral",                descEn: "+$2 upgrade — Rice Bowl",                                   descEs: "+$2 — Rice Bowl" },
    { nameEn: "Vermicelli Noodles",      nameEs: "Fideos Vermicelli",             descEn: "Vermicelli Bowl base / Spring Rolls — pre-cooked, cold",    descEs: "Base de Vermicelli Bowl / Spring Rolls — pre-cocidos, fríos" },
    { nameEn: "Pho Rice Noodles",        nameEs: "Fideos de Arroz (Pho)",         descEn: "All Pho — gluten-free, blanch to order",                    descEs: "Todos los Pho — sin gluten, escaldar a la orden" },
    { nameEn: "Lo Mein Noodles",         nameEs: "Fideos Lo Mein",                descEn: "All Lo Mein — WHEAT, not gluten-free",                      descEs: "Todos los Lo Mein — TRIGO, no sin gluten" },
    { nameEn: "Spring Mix",              nameEs: "Mezcla de Hojas Verdes",        descEn: "Salad Bowl base — wash + drain morning prep",               descEs: "Base de Salad Bowl — lavar + escurrir en la mañana" },
];

export const BUILD_SHEET_STOCKS = [
    { nameEn: "Beef Pho Stock",                  nameEs: "Caldo de Pho de Res",                  descEn: "Ultimate / Combo / Rare Steak / Brisket / Meatball / Shrimp Pho — fish sauce in base", descEs: "Ultimate / Combo / Bistec / Pecho / Albóndiga / Camarón — lleva salsa de pescado" },
    { nameEn: "Chicken Pho Stock",               nameEs: "Caldo de Pho de Pollo",                descEn: "Chicken Pho / Lemongrass Pho variant",                                                  descEs: "Chicken Pho / variante Lemongrass Pho" },
    { nameEn: "Vegan Pho Stock",                 nameEs: "Caldo de Pho Vegano",                  descEn: "Vegan Pho / Veggies w/ Tofu Pho — fully plant-based",                                   descEs: "Vegan Pho / Veggies w/ Tofu — totalmente vegetal" },
    { nameEn: "Spicy Vegan Lemongrass Stock",    nameEs: "Caldo Vegano Picante con Limoncillo",  descEn: "Spicy Vegan Lemongrass Pho only — keeps separate from Vegan stock",                     descEs: "Sólo Spicy Vegan Lemongrass Pho — separar del caldo vegano" },
];

export const BUILD_SHEET_MADE_AHEAD = [
    { nameEn: "Vietnamese Egg Rolls (uncooked)", nameEs: "Egg Rolls Vietnamitas (crudos)",       descEn: "Pork-filled wrappers — fry to order",                                                     descEs: "Wrappers de cerdo — freír a la orden" },
    { nameEn: "Veggie Egg Rolls (uncooked)",     nameEs: "Egg Rolls Veganos (crudos)",           descEn: "Vegetable-filled wrappers — fry to order",                                                descEs: "Wrappers vegetales — freír a la orden" },
    { nameEn: "Fried Vietnamese Egg Rolls",      nameEs: "Egg Rolls Vietnamitas Fritos",         descEn: "Pre-fried, hold warm — auto-included with pork/beef/chicken bowls",                       descEs: "Pre-fritos, mantener caliente — auto-incluidos con bowls de cerdo/res/pollo" },
    { nameEn: "Fried Veggie Egg Rolls",          nameEs: "Egg Rolls Veganos Fritos",             descEn: "Pre-fried, hold warm — auto-included with tofu/vegan/fish bowls",                         descEs: "Pre-fritos, mantener caliente — auto-incluidos con bowls de tofu/vegano/pescado" },
    { nameEn: "Krab Rangoon (uncooked)",         nameEs: "Krab Rangoons (crudos)",               descEn: "Pre-stuffed wrappers — fry to order",                                                     descEs: "Pre-rellenos — freír a la orden" },
    { nameEn: "Vegan Cheese Rolls (uncooked)",   nameEs: "Vegan Cheese Rolls (crudos)",          descEn: "Pre-stuffed almond-cream-cheese wrappers — fry to order",                                 descEs: "Pre-rellenos con queso crema de almendra — freír a la orden" },
    { nameEn: "Bao Buns (steamed)",              nameEs: "Pan Bao (al vapor)",                   descEn: "Pre-steamed, hold warm — Bao Sliders. CONTAINS DAIRY (milk in the dough).",                descEs: "Pre-cocidos al vapor — Bao Sliders. LLEVA LÁCTEO (leche en la masa)." },
    { nameEn: "Spring Rolls (fresh, ready)",     nameEs: "Spring Rolls (frescos, listos)",       descEn: "Rice paper rolls — hold cold, peanut sauce on side",                                      descEs: "Rollos de papel de arroz — frío, salsa de cacahuate al lado" },
];

// Andrew 2026-05-20: "what about the vegetables?" — same logic as
// the proteins: cabbage/cucumber/pickled-medley/etc. are prepped in
// batch every morning, each tub needs a date sticker. Order roughly
// matches prep frequency (red cabbage shows up on basically every
// dish; lime wedges only show up on Pho).
export const BUILD_SHEET_VEGETABLES = [
    { nameEn: "Red Cabbage",        nameEs: "Repollo Rojo",                 descEn: "Shredded — Bowls / Bao / Spring Rolls / Tacos",                 descEs: "Rallado — Bowls / Bao / Spring Rolls / Tacos" },
    { nameEn: "Lettuce",            nameEs: "Lechuga",                      descEn: "Chopped — Bowls / Spring Rolls",                                descEs: "Picada — Bowls / Spring Rolls" },
    { nameEn: "Cucumber",           nameEs: "Pepino",                       descEn: "Sliced — Bowls / Bánh Mì / Spring Rolls",                       descEs: "Rebanado — Bowls / Bánh Mì / Spring Rolls" },
    { nameEn: "Pickled Medley",     nameEs: "Encurtido (zanahoria/daikon)", descEn: "Carrot + daikon julienne — Bowls / Bánh Mì / Bao / Tacos",      descEs: "Zanahoria + daikon en juliana — Bowls / Bánh Mì / Bao / Tacos" },
    { nameEn: "Cilantro",           nameEs: "Cilantro",                     descEn: "Fresh — Bowls / Bánh Mì / Pho / all handhelds",                 descEs: "Fresco — Bowls / Bánh Mì / Pho / todos los handhelds" },
    { nameEn: "Scallions",          nameEs: "Cebolla Verde",                descEn: "Sliced — Bowls / Pho / Fried Rice",                             descEs: "Rebanada — Bowls / Pho / Fried Rice" },
    { nameEn: "White Onion",        nameEs: "Cebolla Blanca",               descEn: "Diced — Pho / Fried Rice",                                      descEs: "Picada — Pho / Fried Rice" },
    { nameEn: "Jalapeños",          nameEs: "Jalapeños",                    descEn: "Sliced — Bánh Mì / Tacos",                                      descEs: "Rebanados — Bánh Mì / Tacos" },
    { nameEn: "Thai Basil",         nameEs: "Albahaca Tailandesa",          descEn: "Garnish plate — Pho",                                           descEs: "Plato de guarnición — Pho" },
    { nameEn: "Beansprouts",        nameEs: "Germinados",                   descEn: "Garnish plate — Pho",                                           descEs: "Plato de guarnición — Pho" },
    { nameEn: "Lime Wedges",        nameEs: "Limones (gajos)",              descEn: "Garnish plate — Pho",                                           descEs: "Plato de guarnición — Pho" },
    { nameEn: "Fried Shallots",     nameEs: "Cebollas Fritas",              descEn: "Crispy topping — Bowls",                                        descEs: "Topping crujiente — Bowls" },
    { nameEn: "Crushed Peanuts",    nameEs: "Cacahuetes Molidos",           descEn: "Topping — Bowls (omit for peanut allergy)",                     descEs: "Topping — Bowls (omitir si alergia al cacahuate)" },
    { nameEn: "Egg (over easy)",    nameEs: "Huevo Estrellado",             descEn: "Default topping — Rice Bowl",                                   descEs: "Topping por defecto — Rice Bowl" },
];

export const BUILD_SHEET_BOWL_PROTEINS = [
    { nameEn: "Lemongrass Pork",       nameEs: "Cerdo al limoncillo",      descEn: "Marinated, grilled — also for Bánh Mì / Sliders / Tacos / Lo Mein", descEs: "Marinado, a la parrilla — también para Bánh Mì / Sliders / Tacos / Lo Mein" },
    { nameEn: "Lemongrass Chicken",    nameEs: "Pollo al limoncillo",      descEn: "Marinated, grilled — also for Bánh Mì / Sliders / Tacos / Lo Mein", descEs: "Marinado, a la parrilla — también para Bánh Mì / Sliders / Tacos / Lo Mein" },
    { nameEn: "Lemongrass Steak",      nameEs: "Carne al limoncillo",      descEn: "Marinated, grilled — also for Lo Mein / Fried Rice",                 descEs: "Marinada, a la parrilla — también para Lo Mein / Fried Rice" },
    { nameEn: "Lemongrass Shrimp",     nameEs: "Camarón al limoncillo",    descEn: "8 per bowl (2 in combo) — also for Bánh Mì / Sliders / Tacos",      descEs: "8 por bowl (2 en combo) — también para Bánh Mì / Sliders / Tacos" },
    { nameEn: "Roast Pork",            nameEs: "Cerdo asado",              descEn: "Char siu / pork belly — also for Bánh Mì",                          descEs: "Char siu / panceta — también para Bánh Mì" },
    { nameEn: "Coconut Shrimp",        nameEs: "Camarón con coco",         descEn: "Coconut-battered, fried",                                            descEs: "Empanizado con coco, frito" },
    { nameEn: "Cajun Salmon",          nameEs: "Salmón Cajún",             descEn: "Cajun-seasoned, pan-seared",                                         descEs: "Sazón cajún, a la sartén" },
    { nameEn: "Fried Fish",            nameEs: "Pescado frito",            descEn: "Crispy battered fish",                                               descEs: "Pescado empanizado y frito" },
    { nameEn: "Tofu",                  nameEs: "Tofu",                     descEn: "Marinated, pan-fried — also for Bánh Mì / Lo Mein / Fried Rice",     descEs: "Marinado, a la sartén — también para Bánh Mì / Lo Mein / Fried Rice" },
    { nameEn: "Vegan Beef",            nameEs: "Carne vegana",             descEn: "Plant-based beef substitute",                                        descEs: "Sustituto vegetal de carne" },
    { nameEn: "Vegan Chikn",           nameEs: "Pollo vegano",             descEn: "Plant-based chicken substitute",                                     descEs: "Sustituto vegetal de pollo" },
    { nameEn: "Vegan Shrimp",          nameEs: "Camarón vegano",           descEn: "Plant-based shrimp substitute",                                      descEs: "Sustituto vegetal de camarón" },
];

export const BUILD_SHEET_FRIED_RICE_PROTEINS = [
    { nameEn: "Roast Pork",            nameEs: "Cerdo asado",              descEn: "Char siu — used in Combo Fried Rice",                               descEs: "Char siu — usado en Combo Fried Rice" },
    { nameEn: "Lemongrass Chicken",    nameEs: "Pollo al limoncillo",      descEn: "Shared with Bowls / Bánh Mì / Lo Mein",                              descEs: "Compartido con Bowls / Bánh Mì / Lo Mein" },
    { nameEn: "Lemongrass Steak",      nameEs: "Carne al limoncillo",      descEn: "Shared with Bowls / Lo Mein",                                        descEs: "Compartido con Bowls / Lo Mein" },
    { nameEn: "Lemongrass Shrimp",     nameEs: "Camarón al limoncillo",    descEn: "8 per order; combo gets 5",                                          descEs: "8 por orden; combo lleva 5" },
    { nameEn: "Ham",                   nameEs: "Jamón",                    descEn: "Diced ham — UNIQUE to Fried Rice (not in bowls combo)",              descEs: "Jamón en cubitos — ÚNICO de Fried Rice" },
    { nameEn: "Tofu",                  nameEs: "Tofu",                     descEn: "Marinated, pan-fried",                                               descEs: "Marinado, a la sartén" },
    { nameEn: "Fish Balls",            nameEs: "Bolas de pescado",         descEn: "For Seafood Fried Rice",                                             descEs: "Para Seafood Fried Rice" },
    { nameEn: "Calamari",              nameEs: "Calamar",                  descEn: "For Seafood Fried Rice",                                             descEs: "Para Seafood Fried Rice" },
    { nameEn: "Vegan Chikn",           nameEs: "Pollo vegano",             descEn: "Plant-based chicken substitute",                                     descEs: "Sustituto vegetal de pollo" },
    { nameEn: "Vegan Beef",            nameEs: "Carne vegana",             descEn: "Plant-based beef substitute",                                        descEs: "Sustituto vegetal de carne" },
    { nameEn: "Vegan Shrimp",          nameEs: "Camarón vegano",           descEn: "Plant-based shrimp substitute",                                      descEs: "Sustituto vegetal de camarón" },
];

export const BUILD_SHEET_PHO_PROTEINS = [
    // Beef-broth proteins
    { nameEn: "Rare Steak",            nameEs: "Bistec poco cocido",       descEn: "Flank meat, thin slice — Beef broth",                                descEs: "Carne de flanco en rebanadas finas — caldo de res" },
    { nameEn: "Brisket",               nameEs: "Pecho de res",             descEn: "Slow-cooked brisket — Beef broth",                                   descEs: "Pecho lento — caldo de res" },
    { nameEn: "Meatball",              nameEs: "Albóndiga",                descEn: "Beef meatballs — Beef broth",                                        descEs: "Albóndigas de res — caldo de res" },
    { nameEn: "Tendon",                nameEs: "Tendón",                   descEn: "Slow-cooked tendon — Ultimate Pho",                                  descEs: "Tendón lento — Ultimate Pho" },
    { nameEn: "Tripe",                 nameEs: "Callos",                   descEn: "Beef tripe — Ultimate Pho",                                          descEs: "Callos de res — Ultimate Pho" },
    { nameEn: "Shrimp",                nameEs: "Camarón",                  descEn: "Lemongrass shrimp — Beef or Seafood broth",                          descEs: "Camarón al limoncillo — caldo de res o mariscos" },
    { nameEn: "Fish Balls",            nameEs: "Bolas de pescado",         descEn: "Seafood Pho",                                                        descEs: "Seafood Pho" },
    { nameEn: "Calamari",              nameEs: "Calamar",                  descEn: "Seafood Pho",                                                        descEs: "Seafood Pho" },
    { nameEn: "Imitation Crab",        nameEs: "Surimi (cangrejo)",        descEn: "Seafood Pho — Beef broth variant",                                   descEs: "Surimi — variante con caldo de res" },
    { nameEn: "Scallops",              nameEs: "Vieiras",                  descEn: "Seafood Pho — Beef broth variant",                                   descEs: "Vieiras — variante con caldo de res" },
    { nameEn: "Squid",                 nameEs: "Calamar",                  descEn: "Seafood Pho — Beef broth variant",                                   descEs: "Calamar — variante con caldo de res" },
    // Chicken-broth proteins
    { nameEn: "Chicken (sliced)",      nameEs: "Pollo en rebanadas",       descEn: "Chicken Pho — Chicken broth",                                        descEs: "Chicken Pho — caldo de pollo" },
    { nameEn: "Lemongrass Chicken",    nameEs: "Pollo al limoncillo",      descEn: "Lemongrass Pho variant",                                             descEs: "Variante Lemongrass Pho" },
    { nameEn: "Lemongrass Beef",       nameEs: "Carne al limoncillo",      descEn: "Lemongrass Pho variant",                                             descEs: "Variante Lemongrass Pho" },
    // Vegan-broth proteins
    { nameEn: "Tofu",                  nameEs: "Tofu",                     descEn: "Vegan Pho / Veggies w/ Tofu Pho",                                    descEs: "Vegan Pho / Veggies w/ Tofu Pho" },
    { nameEn: "Deep-fried Tofu",       nameEs: "Tofu frito",               descEn: "Spicy Vegan Lemongrass Pho",                                         descEs: "Spicy Vegan Lemongrass Pho" },
    { nameEn: "King Mushroom",         nameEs: "Hongo king",               descEn: "Spicy Vegan Lemongrass Pho",                                         descEs: "Spicy Vegan Lemongrass Pho" },
    { nameEn: "Oyster Mushroom",       nameEs: "Hongo ostra",              descEn: "Spicy Vegan Lemongrass Pho",                                         descEs: "Spicy Vegan Lemongrass Pho" },
];

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
