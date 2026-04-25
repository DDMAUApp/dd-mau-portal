// DD Mau Prep List — stations and items from Prep List spreadsheet
// ingredients: array of inventory item IDs (from inventory.js) — linked by manager
// prepDays: array of day numbers (0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat)

export const PREP_STATIONS = [
    {
        id: 0,
        name: "Meat Station",
        nameEs: "Estacion de Carne",
        items: [
            { id: "p0-0", name: "Lemongrass Beef", nameEs: "Res con Limoncillo", slowPar: "2 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p0-1", name: "Lemongrass Chicken", nameEs: "Pollo con Limoncillo", slowPar: "3 pan", busyPar: "3 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p0-2", name: "Lemongrass Pork", nameEs: "Cerdo con Limoncillo", slowPar: "2 pan", busyPar: "3 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p0-3", name: "Lemongrass Shrimp", nameEs: "Camaron con Limoncillo", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p0-4", name: "Vegan Beef", nameEs: "Res Vegana", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p0-5", name: "Vegan Shrimp", nameEs: "Camaron Vegano", slowPar: "1 pan", busyPar: "1 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p0-6", name: "Eggs", nameEs: "Huevos", slowPar: "1 pan", busyPar: "1 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p0-7", name: "Roti", nameEs: "Roti", slowPar: "2 packs", busyPar: "3 packs", unit: "packs", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p0-8", name: "Glaze", nameEs: "Glaseado", slowPar: "1 gallon", busyPar: "1 gallon", unit: "gallon", ingredients: [], prepDays: [1,2,3,4,5,6] }
        ]
    },
    {
        id: 1,
        name: "Veggie Station",
        nameEs: "Estacion de Vegetales",
        items: [
            { id: "p1-0", name: "Red Cabbage", nameEs: "Col Morada", slowPar: "2 pan", busyPar: "3 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p1-1", name: "Lettuce", nameEs: "Lechuga", slowPar: "4 pan", busyPar: "6 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p1-2", name: "Cucumber", nameEs: "Pepino", slowPar: "4 pan", busyPar: "6 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p1-3", name: "Pickled Medley", nameEs: "Mezcla Encurtida", slowPar: "4 pan", busyPar: "6 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p1-4", name: "Cilantro", nameEs: "Cilantro", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p1-5", name: "Jalapenos", nameEs: "Jalapenos", slowPar: "1 pan", busyPar: "1 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p1-6", name: "Green Onion Oil", nameEs: "Aceite de Cebolla Verde", slowPar: "2 pan", busyPar: "4 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p1-7", name: "Fried Shallots", nameEs: "Chalotes Fritos", slowPar: "2 pan", busyPar: "3 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p1-8", name: "Peanuts", nameEs: "Cacahuates", slowPar: "2 pan", busyPar: "3 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p1-9", name: "Mayo", nameEs: "Mayonesa", slowPar: "1 pan", busyPar: "1 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] }
        ]
    },
    {
        id: 2,
        name: "Pho Station",
        nameEs: "Estacion de Pho",
        items: [
            { id: "p2-0", name: "Cilantro", nameEs: "Cilantro", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p2-1", name: "White Onion", nameEs: "Cebolla Blanca", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p2-2", name: "Green Onion", nameEs: "Cebolla Verde", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p2-3", name: "Veggies (carrots, cabbage, broc)", nameEs: "Vegetales (zanahoria, col, brocoli)", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p2-4", name: "Tofu", nameEs: "Tofu", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p2-5", name: "Brisket", nameEs: "Pecho de Res", slowPar: "2 pan", busyPar: "3 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p2-6", name: "Meatball", nameEs: "Albondiga", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p2-7", name: "1.5oz (Rare Steak)", nameEs: "1.5oz (Bistec Crudo)", slowPar: "30", busyPar: "40", unit: "portions", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p2-8", name: "3oz (Rare Steak)", nameEs: "3oz (Bistec Crudo)", slowPar: "30", busyPar: "40", unit: "portions", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p2-9", name: "Oxtail", nameEs: "Cola de Res", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p2-10", name: "Seafood", nameEs: "Mariscos", slowPar: "8 orders", busyPar: "10 orders", unit: "orders", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p2-11", name: "Shrimp", nameEs: "Camaron", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p2-12", name: "Chicken Breast", nameEs: "Pechuga de Pollo", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p2-13", name: "Tofu and Mushroom Mix", nameEs: "Mezcla de Tofu y Hongos", slowPar: "2 (32oz)", busyPar: "3 (32oz)", unit: "32oz containers", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p2-14", name: "Vegan Pho", nameEs: "Pho Vegano", slowPar: "15 orders", busyPar: "18 orders", unit: "orders", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p2-15", name: "Spicy Vegan Lemongrass Soup", nameEs: "Sopa Vegana Picante de Limoncillo", slowPar: "15 orders", busyPar: "20 orders", unit: "orders", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p2-16", name: "Portioned Noodles", nameEs: "Fideos Porcionados", slowPar: "2 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p2-17", name: "Beef Pho", nameEs: "Pho de Res", slowPar: "6 (5 gallon)", busyPar: "6 (5 gallon)", unit: "5-gal buckets", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p2-18", name: "Chicken Pho", nameEs: "Pho de Pollo", slowPar: "1 (5 gallon)", busyPar: "2 (5 gallon)", unit: "5-gal buckets", ingredients: [], prepDays: [1,2,3,4,5,6] }
        ]
    },
    {
        id: 3,
        name: "Fried Rice Station",
        nameEs: "Estacion de Arroz Frito",
        items: [
            { id: "p3-0", name: "Beef", nameEs: "Res", slowPar: "1 pan", busyPar: "1 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p3-1", name: "Chicken", nameEs: "Pollo", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p3-2", name: "Ham", nameEs: "Jamon", slowPar: "1 pan", busyPar: "1 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p3-3", name: "Roast Pork", nameEs: "Cerdo Asado", slowPar: "1 pan", busyPar: "1 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p3-4", name: "Shrimp", nameEs: "Camaron", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p3-5", name: "White Onion-Diced", nameEs: "Cebolla Blanca Picada", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p3-6", name: "Green Onion", nameEs: "Cebolla Verde", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p3-7", name: "Eggs", nameEs: "Huevos", slowPar: "1 bottle", busyPar: "2 bottle", unit: "bottle", ingredients: [], prepDays: [1,2,3,4,5,6] }
        ]
    },
    {
        id: 4,
        name: "Banh Mi, Bao & Spring Roll",
        nameEs: "Banh Mi, Bao y Rollitos",
        items: [
            { id: "p4-0", name: "Banh Mi", nameEs: "Banh Mi", slowPar: "20 orders", busyPar: "30 orders", unit: "orders", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p4-1", name: "Baos", nameEs: "Baos", slowPar: "4 bags", busyPar: "5 bags", unit: "bags", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p4-2", name: "Pate", nameEs: "Pate", slowPar: "1 16oz", busyPar: "1 16oz", unit: "16oz", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p4-3", name: "Traditional Banh Mi Meat", nameEs: "Carne Tradicional Banh Mi", slowPar: "5 orders", busyPar: "10 orders", unit: "orders", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p4-4", name: "Vegan Mayo", nameEs: "Mayonesa Vegana", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p4-5", name: "Pickled Medley", nameEs: "Mezcla Encurtida", slowPar: "1 pan", busyPar: "1 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p4-6", name: "Cilantro", nameEs: "Cilantro", slowPar: "1 pan", busyPar: "1 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p4-7", name: "Red Cabbage", nameEs: "Col Morada", slowPar: "1 pan", busyPar: "1 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p4-8", name: "Jalapenos", nameEs: "Jalapenos", slowPar: "1 pan", busyPar: "1 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p4-9", name: "Vermicelli Noodle", nameEs: "Fideos de Vermicelli", slowPar: "2 tub", busyPar: "3 tub", unit: "tub", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p4-10", name: "Veggies for Spring Roll", nameEs: "Vegetales para Rollito", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p4-11", name: "Spring Roll Wrapper", nameEs: "Envoltura de Rollito", slowPar: "3 packs", busyPar: "4 packs", unit: "packs", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p4-12", name: "Toothpicks", nameEs: "Palillos", slowPar: "1 pan", busyPar: "1 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] }
        ]
    },
    {
        id: 5,
        name: "Fry Station",
        nameEs: "Estacion de Fritura",
        items: [
            { id: "p5-0", name: "Chicken Wings", nameEs: "Alitas de Pollo", slowPar: "2 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p5-1", name: "Crab Rangoon", nameEs: "Crab Rangoon", slowPar: "1 tray", busyPar: "2 trays", unit: "trays", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p5-2", name: "Fish", nameEs: "Pescado", slowPar: "2 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p5-3", name: "Fried Shrimp Roll", nameEs: "Rollo de Camaron Frito", slowPar: "2 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p5-4", name: "Vegan Cheese Rolls", nameEs: "Rollos de Queso Vegano", slowPar: "2 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p5-5", name: "Veggie Egg Rolls", nameEs: "Rollos de Huevo Vegetal", slowPar: "1 pan", busyPar: "1 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p5-6", name: "Vietnamese Egg Roll", nameEs: "Rollo de Huevo Vietnamita", slowPar: "1 pan", busyPar: "1 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p5-7", name: "Tofu", nameEs: "Tofu", slowPar: "2 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p5-8", name: "Sesame Balls", nameEs: "Bolas de Sesamo", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] }
        ]
    },
    {
        id: 6,
        name: "Dessert Station",
        nameEs: "Estacion de Postres",
        items: [
            { id: "p6-0", name: "Vegan Chocolate Cake", nameEs: "Pastel de Chocolate Vegano", slowPar: "6 orders", busyPar: "10 orders", unit: "orders", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p6-1", name: "Flan", nameEs: "Flan", slowPar: "12 orders", busyPar: "12 orders", unit: "orders", ingredients: [], prepDays: [1,2,3,4,5,6] }
        ]
    },
    {
        id: 7,
        name: "Drink Station",
        nameEs: "Estacion de Bebidas",
        items: [
            { id: "p7-0", name: "Vietnamese Coffee", nameEs: "Cafe Vietnamita", slowPar: "16 orders", busyPar: "20 orders", unit: "orders", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p7-1", name: "Lychee Limeade", nameEs: "Limonada de Lichi", slowPar: "12 orders", busyPar: "20 orders", unit: "orders", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p7-2", name: "Thai Iced Tea", nameEs: "Te Helado Thai", slowPar: "16 orders", busyPar: "20 orders", unit: "orders", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p7-3", name: "Matcha Green Tea", nameEs: "Te Verde Matcha", slowPar: "12 orders", busyPar: "12 orders", unit: "orders", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p7-4", name: "Masala Chai Tea", nameEs: "Te Chai Masala", slowPar: "10 orders", busyPar: "10 orders", unit: "orders", ingredients: [], prepDays: [1,2,3,4,5,6] }
        ]
    },
    {
        id: 8,
        name: "Sauces",
        nameEs: "Salsas",
        items: [
            { id: "p8-0", name: "Vietnamese Vinaigrette", nameEs: "Vinagreta Vietnamita", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p8-1", name: "Sweet Chili", nameEs: "Chile Dulce", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p8-2", name: "Hoisin", nameEs: "Hoisin", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p8-3", name: "Peanut", nameEs: "Cacahuate", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p8-4", name: "Spicy Peanut", nameEs: "Cacahuate Picante", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p8-5", name: "DD", nameEs: "DD", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p8-6", name: "Spicy DD", nameEs: "DD Picante", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p8-7", name: "Creamy Sweet Chili", nameEs: "Chile Dulce Cremoso", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p8-8", name: "Vegan Vietnamese Vinaigrette", nameEs: "Vinagreta Vietnamita Vegana", slowPar: "1 pan", busyPar: "2 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p8-9", name: "Ranch", nameEs: "Ranch", slowPar: "1 pan", busyPar: "1 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] },
            { id: "p8-10", name: "Churro Sauce", nameEs: "Salsa de Churro", slowPar: "1 pan", busyPar: "1 pan", unit: "pan", ingredients: [], prepDays: [1,2,3,4,5,6] }
        ]
    }
];
