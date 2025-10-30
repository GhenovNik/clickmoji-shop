import Link from 'next/link';

export default function Home() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="text-center">
        <h1 className="text-6xl font-bold mb-4">🛒 Clickmoji Shop</h1>
        <p className="text-xl text-gray-700 mb-8">
          Visual shopping list with emoji
        </p>
        <div className="text-4xl space-x-2 mb-8">
          🍅 🥒 🧅 🥛 🍞 🥚
        </div>

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/categories"
            className="inline-block bg-blue-600 hover:bg-blue-700 text-white px-8 py-4 rounded-xl font-semibold text-lg transition-colors shadow-lg hover:shadow-xl"
          >
            Начать покупки
          </Link>
          <Link
            href="/shopping-list"
            className="inline-block bg-green-600 hover:bg-green-700 text-white px-8 py-4 rounded-xl font-semibold text-lg transition-colors shadow-lg hover:shadow-xl"
          >
            Мой список
          </Link>
        </div>
      </div>
    </div>
  );
}
