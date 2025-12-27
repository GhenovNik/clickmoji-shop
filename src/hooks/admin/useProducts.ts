import { useState, useEffect } from 'react';

interface Product {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  isCustom: boolean;
  imageUrl: string | null;
  categoryId: string;
  category: {
    id: string;
    name: string;
    emoji: string;
    isCustom: boolean;
    imageUrl: string | null;
  };
}

export function useProducts() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchProducts = async () => {
    try {
      const res = await fetch('/api/products');
      const data = await res.json();
      setProducts(data);
    } catch (error) {
      console.error('Error fetching products:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProducts();
  }, []);

  const createProduct = async (
    productData: {
      name: string;
      nameEn: string;
      emoji: string;
      categoryId: string;
      isCustom: boolean;
      imageUrl: string;
    },
    imageUrl?: string
  ) => {
    const res = await fetch('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...productData,
        isCustom: productData.isCustom || !!imageUrl,
        imageUrl: imageUrl || null,
      }),
    });

    if (!res.ok) {
      throw new Error('Failed to create product');
    }

    const savedProduct = await res.json();
    await fetchProducts();
    return savedProduct;
  };

  const updateProduct = async (
    id: string,
    productData: {
      name: string;
      nameEn: string;
      emoji: string;
      categoryId: string;
      isCustom: boolean;
      imageUrl: string;
    },
    imageUrl?: string
  ) => {
    const res = await fetch(`/api/products/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...productData,
        isCustom: productData.isCustom || !!imageUrl,
        imageUrl: imageUrl || null,
      }),
    });

    if (!res.ok) {
      throw new Error('Failed to update product');
    }

    const savedProduct = await res.json();
    await fetchProducts();
    return savedProduct;
  };

  const deleteProduct = async (id: string) => {
    if (!confirm('Вы уверены?')) {
      return false;
    }

    const res = await fetch(`/api/products/${id}`, {
      method: 'DELETE',
    });

    if (!res.ok) {
      throw new Error('Failed to delete product');
    }

    await fetchProducts();
    return true;
  };

  return {
    products,
    loading,
    fetchProducts,
    createProduct,
    updateProduct,
    deleteProduct,
  };
}
