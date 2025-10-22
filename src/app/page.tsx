export default function Home() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="text-center">
        <h1 className="text-6xl font-bold mb-4">🛒 Clickmoji Shop</h1>
        <p className="text-xl text-gray-700 mb-8">
          Visual shopping list with emoji
        </p>
        <div className="text-4xl space-x-2">
          🍅 🥒 🧅 🥛 🍞 🥚
        </div>
      </div>
    </div>
  );
}
