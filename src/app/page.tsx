import Link from 'next/link';
import UserMenu from '@/components/UserMenu';

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <header className="absolute top-0 right-0 p-4">
        <UserMenu />
      </header>
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
        <h1 className="text-6xl font-bold mb-4 text-gray-900">🛒 Clickmoji Shop</h1>
        <p className="text-xl text-gray-700 mb-8">
          Visual shopping list with emoji
        </p>
        <div className="text-4xl space-x-2 mb-8">
          🍅 🥒 🧅 🥛 🍞 🥚
        </div>

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/lists"
            className="inline-block bg-blue-600 hover:bg-blue-700 text-white px-8 py-4 rounded-xl font-semibold text-lg transition-colors shadow-lg hover:shadow-xl"
          >
            📋 Мои списки
          </Link>
          <Link
            href="/history"
            className="inline-block bg-purple-600 hover:bg-purple-700 text-white px-8 py-4 rounded-xl font-semibold text-lg transition-colors shadow-lg hover:shadow-xl"
          >
            📜 История
          </Link>
        </div>
        </div>
      </div>
    </div>
  );
}
