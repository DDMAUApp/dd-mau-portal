// DD Mau Menu Reference — sourced from official menus (Main, Maryland Heights, To-Go).
// Last updated 2026-05-08 from Andrew's PDFs.
//
// Schema:
//   { category, categoryEs, note?, noteEs?, customizable?, items: [
//       { nameEn, nameEs?, nameVi?, price, descEn, descEs, allergens, spicy?, vegan?, glutenFree?, popular? }
//   ]}
//
// `customizable` is a list of dietary mods that apply to the whole category
// (e.g. bowls can be made vegan/gluten-free/vegetarian by swapping protein).
// `allergens` is a short staff-facing string. The full chart lives in
// Training M17 L3/L4 — staff should always defer to that for serious allergies.

export const MENU_DATA = [
    // ── BOWLS ──────────────────────────────────────────────────────────────
    {
        category: "Bowls",
        categoryEs: "Bowls",
        note: "Style: Salad / Vermicelli / Rice. Rice contains egg — request 'no egg' for vegan rice bowls. Brown rice +$2. Optional crushed peanut topping (omit for peanut-allergic guests). Default vinaigrette has fish sauce — sub Vegan Vinaigrette for vegan/fish-free.",
        noteEs: "Estilo: Ensalada / Vermicelli / Arroz. El arroz lleva huevo — pide 'sin huevo' para bowls veganos. Arroz integral +$2. Topping de cacahuate molido es OPCIONAL (omitir si alergia). La vinagreta lleva salsa de pescado — usa Vinagreta Vegana para vegano/sin pescado.",
        customizable: ["gluten-free", "vegan", "vegetarian"],
        items: [
            { nameEn: "Combo (3 proteins)", price: "$18", descEn: "Pick any 3 proteins.", descEs: "Elige 3 proteínas.", allergens: "Soy, Fish (vinaigrette). Optional peanut.", popular: true },
            { nameEn: "Coconut Shrimp Bowl", price: "$18", descEn: "Crispy coconut-battered shrimp.", descEs: "Camarón empanizado con coco.", allergens: "Shellfish, Treenut (coconut), Wheat, Soy. Optional peanut." },
            { nameEn: "Salmon Bowl", price: "$18", descEn: "Cajun-seasoned salmon.", descEs: "Salmón con sazón cajún.", allergens: "Fish, Soy. Optional peanut." },
            { nameEn: "Vegan Combo Bowl", price: "$18", descEn: "3 plant-based proteins.", descEs: "3 proteínas vegetales.", allergens: "Soy, Wheat (depending on combo). Optional peanut.", vegan: true },
            { nameEn: "Shrimp Bowl", price: "$16", descEn: "Lemongrass-marinated shrimp.", descEs: "Camarón al limoncillo.", allergens: "Shellfish, Soy. Optional peanut." },
            { nameEn: "Steak Bowl", price: "$16", descEn: "Lemongrass-marinated steak.", descEs: "Carne al limoncillo.", allergens: "Soy. Optional peanut." },
            { nameEn: "Fish Bowl", price: "$16", descEn: "Crispy fried fish.", descEs: "Pescado frito.", allergens: "Fish, Wheat, Soy. Optional peanut." },
            { nameEn: "Vegan Beef Bowl", price: "$16", descEn: "Plant-based beef.", descEs: "Carne vegana.", allergens: "Soy, Wheat. Optional peanut.", vegan: true },
            { nameEn: "Vegan Shrimp Bowl", price: "$16", descEn: "Plant-based shrimp.", descEs: "Camarón vegano.", allergens: "Soy, Wheat. Optional peanut.", vegan: true },
            { nameEn: "Vegan Chikn Bowl", price: "$16", descEn: "Plant-based chicken.", descEs: "Pollo vegano.", allergens: "Soy, Wheat. Optional peanut.", vegan: true },
            { nameEn: "Pork Bowl", price: "$15", descEn: "Roast pork or pork belly.", descEs: "Cerdo asado.", allergens: "Soy. Optional peanut.", popular: true },
            { nameEn: "Chicken Bowl", price: "$15", descEn: "Lemongrass-marinated chicken.", descEs: "Pollo al limoncillo.", allergens: "Soy. Optional peanut.", popular: true },
            { nameEn: "Tofu Bowl", price: "$15", descEn: "Marinated tofu.", descEs: "Tofu marinado.", allergens: "Soy. Optional peanut.", vegan: true },
            { nameEn: "Veggie Bowl", price: "$15", descEn: "Vegetables only.", descEs: "Sólo vegetales.", allergens: "Soy. Optional peanut.", vegan: true },
        ],
    },

    // ── SLIDERS & ROLLS ────────────────────────────────────────────────────
    {
        category: "Sliders & Rolls",
        categoryEs: "Sliders y Rollos",
        note: "Style: Spring Rolls (gluten-free, rice paper) or Bao Sliders (CONTAINS MILK — bao bun is dairy). Spring rolls do NOT come with peanut sauce by default — it's an optional add-on.",
        noteEs: "Estilo: Spring Rolls (sin gluten, papel de arroz) o Bao Sliders (CONTIENE LÁCTEO — el pan bao). Los spring rolls NO vienen con salsa de cacahuate por defecto — es opcional.",
        customizable: ["gluten-free (spring roll only)", "vegan"],
        items: [
            { nameEn: "Coconut Shrimp", price: "$10.50", descEn: "Crispy coconut-battered shrimp.", descEs: "Camarón con coco.", allergens: "Shellfish, Treenut, Wheat, Soy" },
            { nameEn: "Shrimp", price: "$9.50", descEn: "Lemongrass shrimp.", descEs: "Camarón al limoncillo.", allergens: "Shellfish, Soy" },
            { nameEn: "Steak", price: "$9", descEn: "Lemongrass steak.", descEs: "Carne al limoncillo.", allergens: "Soy" },
            { nameEn: "Vegan Beef", price: "$9", descEn: "Plant-based beef.", descEs: "Carne vegana.", allergens: "Soy, Wheat", vegan: true },
            { nameEn: "Vegan Shrimp", price: "$9", descEn: "Plant-based shrimp.", descEs: "Camarón vegano.", allergens: "Soy, Wheat", vegan: true },
            { nameEn: "Vegan Chikn", price: "$9", descEn: "Plant-based chicken.", descEs: "Pollo vegano.", allergens: "Soy, Wheat", vegan: true },
            { nameEn: "Fish", price: "$9", descEn: "Crispy fried fish.", descEs: "Pescado frito.", allergens: "Fish, Wheat, Soy" },
            { nameEn: "Pork", price: "$8", descEn: "Roast pork.", descEs: "Cerdo.", allergens: "Soy" },
            { nameEn: "Chicken", price: "$8", descEn: "Lemongrass chicken.", descEs: "Pollo.", allergens: "Soy" },
            { nameEn: "Tofu", price: "$8", descEn: "Marinated tofu.", descEs: "Tofu.", allergens: "Soy", vegan: true },
            { nameEn: "Veggie", price: "$8", descEn: "Vegetables only.", descEs: "Vegetales.", allergens: "Soy", vegan: true },
        ],
    },

    // ── BANH MI ────────────────────────────────────────────────────────────
    {
        category: "Bánh Mì",
        categoryEs: "Bánh Mì",
        note: "Vietnamese baguette sandwich — CONTAINS WHEAT. Mayo on default = egg. Spicy by default. Pickled veggies, cilantro, jalapeño included unless requested otherwise.",
        noteEs: "Sándwich vietnamita — CONTIENE TRIGO. La mayonesa lleva huevo. Picante por defecto. Lleva verduras encurtidas, cilantro y jalapeño.",
        items: [
            { nameEn: "Coconut Shrimp Bánh Mì", price: "$14", descEn: "Crispy coconut-battered shrimp.", descEs: "Camarón con coco.", allergens: "Shellfish, Treenut, Wheat, Egg, Soy", spicy: true },
            { nameEn: "Combo Bánh Mì", price: "$14", descEn: "Pâté + cold cuts (classic).", descEs: "Paté + carnes frías.", allergens: "Wheat, Egg, Soy", spicy: true },
            { nameEn: "Steak Bánh Mì", price: "$11", descEn: "Lemongrass steak.", descEs: "Carne al limoncillo.", allergens: "Wheat, Egg, Soy", spicy: true },
            { nameEn: "Veggie Bánh Mì", price: "$11", descEn: "Vegetables only.", descEs: "Vegetales.", allergens: "Wheat, Egg, Soy", spicy: true },
            { nameEn: "Vegan Beef Bánh Mì", price: "$11", descEn: "Plant-based beef.", descEs: "Carne vegana.", allergens: "Wheat, Soy", spicy: true, vegan: true },
            { nameEn: "Vegan Shrimp Bánh Mì", price: "$11", descEn: "Plant-based shrimp.", descEs: "Camarón vegano.", allergens: "Wheat, Soy", spicy: true, vegan: true },
            { nameEn: "Vegan Chikn Bánh Mì", price: "$11", descEn: "Plant-based chicken.", descEs: "Pollo vegano.", allergens: "Wheat, Soy", spicy: true, vegan: true },
            { nameEn: "Shrimp Bánh Mì", price: "$11", descEn: "Lemongrass shrimp.", descEs: "Camarón.", allergens: "Shellfish, Wheat, Egg, Soy", spicy: true },
            { nameEn: "Fish Bánh Mì", price: "$11", descEn: "Crispy fried fish.", descEs: "Pescado.", allergens: "Fish, Wheat, Egg, Soy", spicy: true },
            { nameEn: "Pork Bánh Mì", price: "$10", descEn: "Roast pork.", descEs: "Cerdo.", allergens: "Wheat, Egg, Soy", spicy: true, popular: true },
            { nameEn: "Chicken Bánh Mì", price: "$10", descEn: "Lemongrass chicken.", descEs: "Pollo.", allergens: "Wheat, Egg, Soy", spicy: true, popular: true },
            { nameEn: "Tofu Bánh Mì", price: "$10", descEn: "Marinated tofu.", descEs: "Tofu.", allergens: "Wheat, Egg, Soy", spicy: true, vegan: true },
        ],
    },

    // ── TACOS ──────────────────────────────────────────────────────────────
    {
        category: "Tacos",
        categoryEs: "Tacos",
        note: "Roti tortilla = wheat. Mayo-based sauces = egg. Spicy by default.",
        noteEs: "Tortilla roti = trigo. Salsas con mayo = huevo. Picante por defecto.",
        items: [
            { nameEn: "Coconut Shrimp Taco", price: "$18", descEn: "Crispy coconut-battered shrimp.", descEs: "Camarón con coco.", allergens: "Shellfish, Treenut, Wheat, Egg, Soy", spicy: true },
            { nameEn: "Steak Taco", price: "$15", descEn: "Lemongrass steak.", descEs: "Carne.", allergens: "Wheat, Egg, Soy", spicy: true },
            { nameEn: "Shrimp Taco", price: "$15", descEn: "Lemongrass shrimp.", descEs: "Camarón.", allergens: "Shellfish, Wheat, Egg, Soy", spicy: true },
            { nameEn: "Vegan Chikn Taco", price: "$15", descEn: "Plant-based chicken.", descEs: "Pollo vegano.", allergens: "Wheat, Soy", spicy: true, vegan: true },
            { nameEn: "Vegan Beef Taco", price: "$15", descEn: "Plant-based beef.", descEs: "Carne vegana.", allergens: "Wheat, Soy", spicy: true, vegan: true },
            { nameEn: "Vegan Shrimp Taco", price: "$15", descEn: "Plant-based shrimp.", descEs: "Camarón vegano.", allergens: "Wheat, Soy", spicy: true, vegan: true },
            { nameEn: "Fish Taco", price: "$15", descEn: "Crispy fried fish.", descEs: "Pescado.", allergens: "Fish, Wheat, Egg, Soy", spicy: true },
            { nameEn: "Pork Taco", price: "$14", descEn: "Roast pork.", descEs: "Cerdo.", allergens: "Wheat, Egg, Soy", spicy: true },
            { nameEn: "Chicken Taco", price: "$14", descEn: "Lemongrass chicken.", descEs: "Pollo.", allergens: "Wheat, Egg, Soy", spicy: true },
            { nameEn: "Tofu Taco", price: "$14", descEn: "Marinated tofu.", descEs: "Tofu.", allergens: "Wheat, Egg, Soy", spicy: true, vegan: true },
            { nameEn: "Veggie Taco", price: "$14", descEn: "Vegetables only.", descEs: "Vegetales.", allergens: "Wheat, Egg, Soy", spicy: true, vegan: true },
        ],
    },

    // ── PHO ────────────────────────────────────────────────────────────────
    {
        category: "Pho",
        categoryEs: "Pho",
        note: "GLUTEN-FREE (rice noodles). Broth has fish sauce by default. Vegan pho uses a separate vegan broth — confirm with kitchen. * = consuming raw or undercooked meats/seafood may increase risk of foodborne illness. Regular size only — NO large pho.",
        noteEs: "SIN GLUTEN (fideos de arroz). El caldo lleva salsa de pescado. El pho vegano usa caldo separado — confirma con cocina. * = consumir carnes/mariscos crudos o poco cocinados puede aumentar el riesgo. Sólo tamaño regular — NO hay pho grande.",
        customizable: ["gluten-free (default)", "vegan (vegan broth)"],
        items: [
            { nameEn: "Ultimate Pho", price: "$19", descEn: "Everything — rare steak, brisket, meatball, tendon, tripe.", descEs: "Todo — carne cruda, pecho, albóndiga, tendón, callos.", allergens: "Fish, Soy", spicy: false, popular: true, glutenFree: true },
            { nameEn: "Seafood Pho", price: "$18", descEn: "Shrimp, fish balls, calamari.", descEs: "Camarón, bolas de pescado, calamar.", allergens: "Fish, Shellfish, Soy", glutenFree: true },
            { nameEn: "Combo Pho*", price: "$16", descEn: "Rare steak + brisket + meatball.", descEs: "Carne cruda + pecho + albóndiga.", allergens: "Fish, Soy", glutenFree: true, popular: true },
            { nameEn: "Shrimp Pho", price: "$16", descEn: "Lemongrass shrimp.", descEs: "Camarón.", allergens: "Fish, Shellfish, Soy", glutenFree: true },
            { nameEn: "Rare Steak Pho*", price: "$15", descEn: "Thinly-sliced rare beef.", descEs: "Carne cruda en rebanadas finas.", allergens: "Fish, Soy", glutenFree: true },
            { nameEn: "Lemongrass Pho", price: "$15", descEn: "Lemongrass-marinated chicken or beef.", descEs: "Pollo o carne al limoncillo.", allergens: "Fish, Soy", glutenFree: true },
            { nameEn: "Meatball Pho", price: "$15", descEn: "Beef meatballs.", descEs: "Albóndigas.", allergens: "Fish, Soy", glutenFree: true },
            { nameEn: "Brisket Pho", price: "$15", descEn: "Slow-cooked brisket.", descEs: "Pecho de res.", allergens: "Fish, Soy", glutenFree: true },
            { nameEn: "Chicken Pho", price: "$15", descEn: "Sliced chicken.", descEs: "Pollo.", allergens: "Fish, Soy", glutenFree: true, popular: true },
            { nameEn: "Vegan Pho", price: "$15", descEn: "Plant-based proteins in vegan broth.", descEs: "Proteínas vegetales en caldo vegano.", allergens: "Soy", glutenFree: true, vegan: true },
            { nameEn: "Veggies w/ Tofu Pho", price: "$15", descEn: "Vegetables + tofu in vegan broth.", descEs: "Vegetales + tofu.", allergens: "Soy", glutenFree: true, vegan: true },
        ],
    },

    // ── LO MEIN ────────────────────────────────────────────────────────────
    {
        category: "Lo Mein",
        categoryEs: "Lo Mein",
        note: "Wheat noodles — NOT gluten-free. Sauce = soy sauce + oyster sauce (shellfish) + sesame oil. Our oyster sauce is gluten-free, but the noodles + soy sauce still make this NOT gluten-free.",
        noteEs: "Fideos de trigo — NO sin gluten. Salsa = soya + ostión (mariscos) + ajonjolí. Nuestra salsa de ostión es sin gluten, pero los fideos y la soya hacen que NO sea sin gluten.",
        items: [
            { nameEn: "Seafood Lo Mein", price: "$21", descEn: "Shrimp, fish balls, calamari.", descEs: "Camarón, bolas de pescado, calamar.", allergens: "Shellfish, Fish, Wheat, Soy, Sesame" },
            { nameEn: "Vegan Combo Lo Mein", price: "$21", descEn: "3 plant-based proteins.", descEs: "3 proteínas veganas.", allergens: "Wheat, Soy, Sesame", vegan: true },
            { nameEn: "Combo Lo Mein", price: "$18", descEn: "3 proteins.", descEs: "3 proteínas.", allergens: "Shellfish, Wheat, Soy, Sesame" },
            { nameEn: "Shrimp Lo Mein", price: "$16", descEn: "Lemongrass shrimp.", descEs: "Camarón.", allergens: "Shellfish, Wheat, Soy, Sesame" },
            { nameEn: "Vegan Chikn Lo Mein", price: "$16", descEn: "Plant-based chicken.", descEs: "Pollo vegano.", allergens: "Wheat, Soy, Sesame", vegan: true },
            { nameEn: "Vegan Beef Lo Mein", price: "$16", descEn: "Plant-based beef.", descEs: "Carne vegana.", allergens: "Wheat, Soy, Sesame", vegan: true },
            { nameEn: "Vegan Shrimp Lo Mein", price: "$16", descEn: "Plant-based shrimp.", descEs: "Camarón vegano.", allergens: "Wheat, Soy, Sesame", vegan: true },
            { nameEn: "Steak Lo Mein", price: "$16", descEn: "Lemongrass steak.", descEs: "Carne.", allergens: "Shellfish, Wheat, Soy, Sesame" },
            { nameEn: "Veggie Lo Mein", price: "$15", descEn: "Vegetables only.", descEs: "Vegetales.", allergens: "Shellfish, Wheat, Soy, Sesame", vegan: false },
            { nameEn: "Plain Lo Mein", price: "$15", descEn: "Noodles + sauce only.", descEs: "Sólo fideos y salsa.", allergens: "Shellfish, Wheat, Soy, Sesame" },
            { nameEn: "Pork Lo Mein", price: "$15", descEn: "Roast pork.", descEs: "Cerdo.", allergens: "Shellfish, Wheat, Soy, Sesame" },
            { nameEn: "Chicken Lo Mein", price: "$15", descEn: "Lemongrass chicken.", descEs: "Pollo.", allergens: "Shellfish, Wheat, Soy, Sesame" },
            { nameEn: "Ham Lo Mein", price: "$15", descEn: "Ham.", descEs: "Jamón.", allergens: "Shellfish, Wheat, Soy, Sesame" },
            { nameEn: "Tofu Lo Mein", price: "$15", descEn: "Marinated tofu.", descEs: "Tofu.", allergens: "Shellfish, Wheat, Soy, Sesame" },
        ],
    },

    // ── FRIED RICE ─────────────────────────────────────────────────────────
    {
        category: "Fried Rice",
        categoryEs: "Arroz Frito",
        note: "Contains egg by default. Soy sauce base. Can be made vegan (no egg) on request — confirm with kitchen.",
        noteEs: "Lleva huevo por defecto. Base de salsa de soya. Se puede hacer vegano (sin huevo) si se pide — confirma con cocina.",
        customizable: ["vegan (no egg)", "vegetarian"],
        items: [
            { nameEn: "Seafood Fried Rice", price: "$17.50", descEn: "Shrimp, fish balls, calamari.", descEs: "Camarón, pescado, calamar.", allergens: "Shellfish, Fish, Egg, Soy" },
            { nameEn: "Vegan Combo Fried Rice", price: "$17.50", descEn: "3 plant-based proteins.", descEs: "3 proteínas veganas.", allergens: "Soy", vegan: true },
            { nameEn: "Combo Fried Rice", price: "$14.50", descEn: "3 proteins.", descEs: "3 proteínas.", allergens: "Egg, Soy" },
            { nameEn: "Shrimp Fried Rice", price: "$12.50", descEn: "Lemongrass shrimp.", descEs: "Camarón.", allergens: "Shellfish, Egg, Soy" },
            { nameEn: "Steak Fried Rice", price: "$12.50", descEn: "Lemongrass steak.", descEs: "Carne.", allergens: "Egg, Soy" },
            { nameEn: "Veggie Fried Rice", price: "$12.50", descEn: "Vegetables only.", descEs: "Vegetales.", allergens: "Egg, Soy" },
            { nameEn: "Vegan Chikn Fried Rice", price: "$13", descEn: "Plant-based chicken.", descEs: "Pollo vegano.", allergens: "Soy", vegan: true },
            { nameEn: "Vegan Beef Fried Rice", price: "$13", descEn: "Plant-based beef.", descEs: "Carne vegana.", allergens: "Soy", vegan: true },
            { nameEn: "Vegan Shrimp Fried Rice", price: "$13", descEn: "Plant-based shrimp.", descEs: "Camarón vegano.", allergens: "Soy", vegan: true },
            { nameEn: "Plain Fried Rice", price: "$11.50", descEn: "Rice + egg + soy.", descEs: "Arroz + huevo + soya.", allergens: "Egg, Soy" },
            { nameEn: "Pork Fried Rice", price: "$11.50", descEn: "Roast pork.", descEs: "Cerdo.", allergens: "Egg, Soy" },
            { nameEn: "Chicken Fried Rice", price: "$11.50", descEn: "Lemongrass chicken.", descEs: "Pollo.", allergens: "Egg, Soy" },
            { nameEn: "Ham Fried Rice", price: "$11.50", descEn: "Ham.", descEs: "Jamón.", allergens: "Egg, Soy" },
            { nameEn: "Tofu Fried Rice", price: "$11.50", descEn: "Marinated tofu.", descEs: "Tofu.", allergens: "Egg, Soy" },
        ],
    },

    // ── SNACKS ─────────────────────────────────────────────────────────────
    {
        category: "Snacks",
        categoryEs: "Snacks",
        items: [
            { nameEn: "Thai Chili Pepper Wings (6)", price: "$15", descEn: "Wings tossed in Thai chili seasoning.", descEs: "Alitas con sazón de chile tailandés.", allergens: "Wheat, Soy, may contain Sesame", spicy: true },
            { nameEn: "Buffalo Sweet Chili Wings (6)", price: "$15", descEn: "Buffalo + sweet chili glaze. Buffalo sauce may contain dairy.", descEs: "Salsa buffalo + chile dulce. Buffalo puede llevar lácteo.", allergens: "Wheat, Soy, may contain Dairy/Treenut", spicy: true, popular: true },
            { nameEn: "Sweet Garlic Wings", price: "$16", descEn: "Sweet garlic glaze (16 cups soy sauce base).", descEs: "Glaseado de ajo dulce.", allergens: "Wheat, Soy" },
            { nameEn: "Coconut Shrimp (6)", price: "$13", descEn: "Crispy coconut-battered shrimp.", descEs: "Camarón empanizado con coco.", allergens: "Shellfish, Treenut (coconut), Wheat, Egg, Soy", popular: true },
            { nameEn: "Buffalo Sweet Chili Tofu", price: "$8", descEn: "Plant-based, may contain wheat in sauce.", descEs: "Vegano, salsa puede tener trigo.", allergens: "Soy, may contain Wheat/Dairy", spicy: true, vegan: true },
            { nameEn: "Vegan Popcorn Shrimp (6)", price: "$8.50", descEn: "Plant-based, wheat breading.", descEs: "Vegano, empanizado de trigo.", allergens: "Wheat, Soy", vegan: true },
            { nameEn: "Sweet Potato Waffle Fries", price: "$8", descEn: "Confirm fryer cross-contact.", descEs: "Verifica contacto cruzado en freidora.", allergens: "(check fryer)", vegan: true },
            { nameEn: "Crab Rangoons (3)", price: "$4.50", descEn: "Imitation crab (FISH, not shellfish) + cream cheese in wonton.", descEs: "Cangrejo de imitación (PESCADO, no mariscos) + queso crema.", allergens: "Fish (imitation crab), Dairy, Egg, Wheat" },
            { nameEn: "Crab Rangoons (6)", price: "$7.50", descEn: "Imitation crab (FISH, not shellfish) + cream cheese.", descEs: "Cangrejo de imitación + queso crema.", allergens: "Fish (imitation crab), Dairy, Egg, Wheat", popular: true },
            { nameEn: "Fried Shrimp Rolls (3)", price: "$6.50", descEn: "Shellfish + wheat breading.", descEs: "Mariscos + empanizado de trigo.", allergens: "Shellfish, Egg, Wheat, Soy" },
            { nameEn: "Vegan Cheese Rolls (2)", price: "$6.50", descEn: "Vegan cheese is ALMOND-based (treenut).", descEs: "Queso vegano de ALMENDRA (fruto seco).", allergens: "Treenut (almond), Wheat, Soy", vegan: true },
            { nameEn: "Veggie Egg Rolls (2)", price: "$5", descEn: "3.5 cups sesame oil in mix. Wheat + egg wrapper.", descEs: "Aceite de ajonjolí en relleno. Envoltura trigo + huevo.", allergens: "Egg, Wheat, Soy, Sesame" },
            { nameEn: "Vietnamese Egg Rolls (2)", price: "$5", descEn: "Pork filling + sesame oil. Wheat + egg wrapper.", descEs: "Cerdo + ajonjolí. Envoltura trigo + huevo.", allergens: "Egg, Wheat, Soy, Sesame, may contain Shellfish", popular: true },
        ],
    },

    // ── DRINKS ─────────────────────────────────────────────────────────────
    {
        category: "Drinks",
        categoryEs: "Bebidas",
        note: "Boba milk teas use a creamer labeled 'non-dairy' that CONTAINS milk derivatives (sodium caseinate + lactose) — NOT safe for milk allergies. Fruit teas are SAFE for milk allergies — they're built on a separate path and never touch the creamer. Oat, soy, or almond milk teas also available as alternatives (almond = tree nut). Boba pearls are typically allergen-free.",
        noteEs: "Los boba milk teas usan una crema etiquetada 'non-dairy' que CONTIENE derivados lácteos (caseinato de sodio + lactosa) — NO segura para alergia a leche. Los fruit teas SÍ son seguros para alergia a leche — se arman por separado y nunca tocan la crema. Milk teas con leche de avena, soya o almendra también disponibles (almendra = fruto seco). Las perlas de boba son típicamente sin alérgenos.",
        items: [
            { nameEn: "Lychee Limeade", price: "$6", descEn: "Lychee + lime + soda.", descEs: "Lychee + lima + soda.", allergens: "(none)", vegan: true, glutenFree: true },
            { nameEn: "Matcha Green Tea Latte", price: "$8", descEn: "Real milk default. Oat / soy / almond available. Strawberry / mango / blueberry +$1.", descEs: "Leche real por defecto. Avena / soya / almendra disponible. Fresa / mango / arándano +$1.", allergens: "Dairy (default). Sub oat / soy / almond (almond = tree nut).", popular: true },
            { nameEn: "Vietnamese Coffee", price: "$6", descEn: "Strong coffee + condensed milk.", descEs: "Café fuerte + leche condensada.", allergens: "Dairy", popular: true },
            { nameEn: "Thai Iced Tea", price: "$6", descEn: "Spiced black tea. Made with condensed milk by default; oat / soy / almond available.", descEs: "Té negro especiado. Con leche condensada por defecto; avena / soya / almendra disponible.", allergens: "Dairy (default). Sub oat / soy / almond (almond = tree nut).", popular: true },
            { nameEn: "Masala Chai", price: "$6", descEn: "Spiced milk tea. Real milk default; oat / soy / almond available.", descEs: "Té con especias y leche. Leche real por defecto; avena / soya / almendra disponible.", allergens: "Dairy (default). Sub oat / soy / almond (almond = tree nut)." },
            { nameEn: "Seasonal Hot Teas", price: "$6", descEn: "Rotating selection.", descEs: "Selección rotativa.", allergens: "(varies)", vegan: true, glutenFree: true },
            { nameEn: "Boba Milk Teas", price: "$6.50", descEn: "9 flavors. Creamer labeled 'non-dairy' but contains MILK derivatives (sodium caseinate + lactose) — NOT safe for milk allergies. Sub oat / soy / almond on request.", descEs: "9 sabores. Crema 'non-dairy' pero contiene derivados LÁCTEOS (caseinato + lactosa) — NO segura para alergia a leche. Sustituye avena / soya / almendra.", allergens: "Milk (creamer contains caseinate + lactose). Sub oat / soy / almond (almond = tree nut)." },
        ],
    },

    // ── SWEETS ─────────────────────────────────────────────────────────────
    {
        category: "Sweets",
        categoryEs: "Postres",
        items: [
            { nameEn: "Sesame Balls", price: "$6", descEn: "Glutinous rice (no wheat gluten) coated in sesame seeds.", descEs: "Arroz glutinoso con ajonjolí.", allergens: "Sesame", vegan: true, glutenFree: true },
            { nameEn: "Flan", price: "$5", descEn: "Classic egg + milk + sugar custard.", descEs: "Flan clásico.", allergens: "Egg, Dairy", popular: true },
            { nameEn: "Vietnamese Churros", price: "$6", descEn: "Fried dough.", descEs: "Masa frita.", allergens: "Wheat, Egg, Dairy" },
            { nameEn: "Viet Coffee Tres Leches Cake", price: "$8", descEn: "Tres leches infused with Viet coffee.", descEs: "Tres leches con café vietnamita.", allergens: "Dairy, Egg, Wheat" },
            { nameEn: "Tres Leches Cake", price: "$8", descEn: "Three-milk soaked cake.", descEs: "Pastel tres leches.", allergens: "Dairy, Egg, Wheat" },
            { nameEn: "Chocolate Cake", price: "$8", descEn: "Plant-based chocolate cake.", descEs: "Pastel de chocolate vegano.", allergens: "Wheat, Soy", vegan: true },
            { nameEn: "Iced Oatmeal Cookies (3)", price: "$6.50", descEn: "Plant-based. Oats may cross-contact wheat.", descEs: "Vegano. Avena puede tener contacto cruzado con trigo.", allergens: "Wheat, Soy", vegan: true },
        ],
    },

    // ── SAUCES ─────────────────────────────────────────────────────────────
    {
        category: "Sauces",
        categoryEs: "Salsas",
        note: "Cross-reference with the M17 Allergen Matrix in Training. When in doubt, get the Shift Lead.",
        noteEs: "Verifica con la Matriz de Alérgenos M17. En duda, llama al líder.",
        items: [
            { nameEn: "Vietnamese Vinaigrette", price: "—", descEn: "Fish sauce (nuoc mam) base.", descEs: "Base de salsa de pescado.", allergens: "Fish", glutenFree: true },
            { nameEn: "Vegan Vinaigrette", price: "—", descEn: "Soy replaces fish sauce.", descEs: "Soya reemplaza pescado.", allergens: "Soy", vegan: true, glutenFree: true },
            { nameEn: "Hoisin (DD Mau house)", price: "—", descEn: "House recipe — peanut butter + base hoisin + soy. Contains WHEAT. NO shellfish.", descEs: "Receta de la casa — crema de cacahuate + hoisin base + soya. Lleva TRIGO. SIN mariscos.", allergens: "Peanut, Wheat, Soy", vegan: true },
            { nameEn: "Peanut Sauce", price: "—", descEn: "Peanut butter + house hoisin + sugar. Contains wheat (from hoisin).", descEs: "Cacahuate + hoisin + azúcar. Lleva trigo (del hoisin).", allergens: "Peanut, Wheat, Soy", vegan: true },
            { nameEn: "Spicy Peanut Sauce", price: "—", descEn: "Peanut + cayenne. Contains wheat.", descEs: "Cacahuate + cayena. Lleva trigo.", allergens: "Peanut, Wheat, Soy", vegan: true, spicy: true },
            { nameEn: "Sweet Chili", price: "—", descEn: "Typically allergen-clean.", descEs: "Típicamente sin alérgenos.", allergens: "(none typical)", vegan: true, glutenFree: true },
            { nameEn: "Spicy DD", price: "—", descEn: "DD base + Sriracha + cayenne. Egg yolks.", descEs: "Base DD + Sriracha + cayena. Yemas.", allergens: "Egg", spicy: true },
            { nameEn: "DD Dressing", price: "—", descEn: "Egg yolks + oil + pickled medley + sugar. NO soy, NO fish, NO wheat.", descEs: "Yemas + aceite + pickled + azúcar. SIN soya/pescado/trigo.", allergens: "Egg", popular: true, glutenFree: true },
        ],
    },
];
