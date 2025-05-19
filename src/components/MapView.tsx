import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { LocationData, RouteData, RouteStop, SalesmanRoute } from '../types';

interface MapViewProps {
  locationData: LocationData;
  routes: RouteData;
  onRouteUpdate?: (updatedRoutes: RouteData) => void;
}

const CLUSTER_COLORS = [
  '#3B82F6', // blue
  '#F97316', // orange
  '#10B981', // green
  '#8B5CF6', // purple
  '#EC4899', // pink
  '#EF4444', // red
  '#F59E0B', // amber
  '#6366F1', // indigo
  '#14B8A6', // teal
  '#6B7280', // gray
];

const MapView: React.FC<MapViewProps> = ({ locationData, routes, onRouteUpdate }) => {
  const mapRef = useRef<L.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const routeLayersRef = useRef<L.Polyline[]>([]);
  const markersRef = useRef<{ [key: string]: L.Marker }>({});
  const [draggedStop, setDraggedStop] = useState<{ stop: RouteStop; routeIndex: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [highlightedRoute, setHighlightedRoute] = useState<number | null>(null);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [pendingRouteUpdate, setPendingRouteUpdate] = useState<RouteData | null>(null);
  const [dragEndPosition, setDragEndPosition] = useState<{ lat: number; lng: number } | null>(null);
  const [originalPosition, setOriginalPosition] = useState<{ lat: number; lng: number } | null>(null);
  const [selectedCluster, setSelectedCluster] = useState<number | null>(null);
  const [selectedSalesman, setSelectedSalesman] = useState<number | null>(null);
  const [clusterStats, setClusterStats] = useState<Record<number, { count: number; distance: number }>>({});
  const [clusterPolygons, setClusterPolygons] = useState<L.Polygon[]>([]);

  const calculateHaversineDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 6371;
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * 
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  const calculateTravelTime = (distance: number, speedKmPerHour: number = 30): number => {
    return (distance / speedKmPerHour) * 60;
  };

  const recalculateRouteMetrics = (routes: RouteData): RouteData => {
    const VISIT_TIME = 15;
    const SPEED = 30;

    return routes.map(route => {
      let totalDistance = 0;
      let totalTime = 0;
      let prevLat = locationData.distributor.latitude;
      let prevLng = locationData.distributor.longitude;

      route.stops = route.stops.map((stop, index) => {
        const distance = calculateHaversineDistance(
          prevLat, prevLng,
          stop.latitude, stop.longitude
        );
        const travelTime = calculateTravelTime(distance, SPEED);

        totalDistance += distance;
        totalTime += travelTime + VISIT_TIME;

        prevLat = stop.latitude;
        prevLng = stop.longitude;

        let distanceToNext = 0;
        let timeToNext = 0;
        if (index < route.stops.length - 1) {
          const nextStop = route.stops[index + 1];
          distanceToNext = calculateHaversineDistance(
            stop.latitude, stop.longitude,
            nextStop.latitude, nextStop.longitude
          );
          timeToNext = calculateTravelTime(distanceToNext, SPEED);
        }

        return {
          ...stop,
          distanceToNext,
          timeToNext,
          visitTime: VISIT_TIME
        };
      });

      return {
        ...route,
        totalDistance,
        totalTime,
        clusterIds: [...new Set(route.stops.map(stop => stop.clusterId))]
      };
    });
  };

  const handleConfirmRouteChange = () => {
    if (pendingRouteUpdate && onRouteUpdate) {
      onRouteUpdate(pendingRouteUpdate);
      setShowConfirmation(false);
      setPendingRouteUpdate(null);
      setDragEndPosition(null);
      setOriginalPosition(null);
      updateRouteDisplay();
    }
  };

  const handleCancelRouteChange = () => {
    if (draggedStop && originalPosition && markersRef.current[draggedStop.stop.customerId]) {
      const marker = markersRef.current[draggedStop.stop.customerId];
      marker.setLatLng([originalPosition.lat, originalPosition.lng]);
    }
    setShowConfirmation(false);
    setPendingRouteUpdate(null);
    setDragEndPosition(null);
    setOriginalPosition(null);
    updateRouteDisplay();
  };

  const getRouteColor = (route: SalesmanRoute): string => {
    if (!route.clusterIds || route.clusterIds.length === 0) {
      return CLUSTER_COLORS[0];
    }
    return CLUSTER_COLORS[route.clusterIds[0] % CLUSTER_COLORS.length];
  };

  const createClusterPolygons = () => {
    if (!mapRef.current) return;

    // Remove existing polygons
    clusterPolygons.forEach(polygon => polygon.remove());

    // Group stops by cluster
    const clusterStops: Record<number, [number, number][]> = {};
    routes.forEach(route => {
      route.stops.forEach(stop => {
        if (!clusterStops[stop.clusterId]) {
          clusterStops[stop.clusterId] = [];
        }
        clusterStops[stop.clusterId].push([stop.latitude, stop.longitude]);
      });
    });

    // Create convex hull for each cluster
    const newPolygons: L.Polygon[] = [];
    Object.entries(clusterStops).forEach(([clusterId, stops]) => {
      if (stops.length < 3) return; // Need at least 3 points for a polygon

      // Create a simple convex hull using the Graham scan algorithm
      const hull = grahamScan(stops);
      if (!hull || hull.length < 3) return;

      const color = CLUSTER_COLORS[Number(clusterId) % CLUSTER_COLORS.length];
      const polygon = L.polygon(hull, {
        color,
        fillColor: color,
        fillOpacity: 0.1,
        weight: 2,
        opacity: 0.8
      }).addTo(mapRef.current);

      polygon.bindTooltip(`Cluster ${clusterId} - ${stops.length} outlets`, {
        permanent: false,
        direction: 'center'
      });

      newPolygons.push(polygon);
    });

    setClusterPolygons(newPolygons);
  };

  // Graham Scan algorithm for convex hull
  const grahamScan = (points: [number, number][]): [number, number][] => {
    if (points.length < 3) return points;

    // Find the point with the lowest y-coordinate (and leftmost if tied)
    let bottomPoint = points[0];
    for (let i = 1; i < points.length; i++) {
      if (points[i][1] < bottomPoint[1] || 
         (points[i][1] === bottomPoint[1] && points[i][0] < bottomPoint[0])) {
        bottomPoint = points[i];
      }
    }

    // Sort points by polar angle with respect to bottom point
    const sortedPoints = points
      .filter(p => p !== bottomPoint)
      .sort((a, b) => {
        const angleA = Math.atan2(a[1] - bottomPoint[1], a[0] - bottomPoint[0]);
        const angleB = Math.atan2(b[1] - bottomPoint[1], b[0] - bottomPoint[0]);
        return angleA - angleB;
      });

    // Initialize stack with first three points
    const stack: [number, number][] = [bottomPoint, sortedPoints[0]];

    // Process remaining points
    for (let i = 1; i < sortedPoints.length; i++) {
      while (stack.length > 1 && !isLeftTurn(
        stack[stack.length - 2],
        stack[stack.length - 1],
        sortedPoints[i]
      )) {
        stack.pop();
      }
      stack.push(sortedPoints[i]);
    }

    return stack;
  };

  const isLeftTurn = (p1: [number, number], p2: [number, number], p3: [number, number]): boolean => {
    return ((p2[0] - p1[0]) * (p3[1] - p1[1]) - (p2[1] - p1[1]) * (p3[0] - p1[0])) > 0;
  };

  useEffect(() => {
    // Calculate cluster statistics
    const stats: Record<number, { count: number; distance: number }> = {};
    routes.forEach(route => {
      route.stops.forEach(stop => {
        if (!stats[stop.clusterId]) {
          stats[stop.clusterId] = { count: 0, distance: 0 };
        }
        stats[stop.clusterId].count++;
        stats[stop.clusterId].distance += stop.distanceToNext || 0;
      });
    });
    setClusterStats(stats);
  }, [routes]);

  const updateRouteDisplay = () => {
    if (!mapRef.current) return;

    routeLayersRef.current.forEach(layer => layer.remove());
    routeLayersRef.current = [];

    Object.values(markersRef.current).forEach(marker => {
      marker.setOpacity(0);
    });

    routes.forEach((route, routeIndex) => {
      const shouldShowRoute = (selectedCluster === null || route.stops.some(stop => stop.clusterId === selectedCluster)) &&
                            (selectedSalesman === null || route.salesmanId === selectedSalesman);

      if (!shouldShowRoute) return;

      const pathCoordinates: [number, number][] = [
        [locationData.distributor.latitude, locationData.distributor.longitude],
        ...route.stops
          .filter(stop => selectedCluster === null || stop.clusterId === selectedCluster)
          .map(stop => [stop.latitude, stop.longitude])
      ];

      route.stops.forEach(stop => {
        if ((selectedCluster === null || stop.clusterId === selectedCluster) &&
            (selectedSalesman === null || route.salesmanId === selectedSalesman)) {
          const marker = markersRef.current[stop.customerId];
          if (marker) marker.setOpacity(1);
        }
      });

      const routePath = L.polyline(pathCoordinates, {
        color: getRouteColor(route),
        weight: 3,
        opacity: shouldShowRoute ? 1 : 0.2
      }).addTo(mapRef.current);

      routePath.bindTooltip(
        `Salesman ${route.salesmanId} Route<br>` +
        `Cluster ${route.clusterIds?.join(', ') || 'N/A'}<br>` +
        `Total Distance: ${route.totalDistance.toFixed(2)} km<br>` +
        `Total Time: ${Math.round(route.totalTime)} min`,
        { direction: 'top' }
      );

      routeLayersRef.current.push(routePath);
    });

    if (markersRef.current['distributor']) {
      markersRef.current['distributor'].setOpacity(1);
    }
  };

  useEffect(() => {
    if (!mapRef.current && mapContainerRef.current) {
      mapRef.current = L.map(mapContainerRef.current).setView([0, 0], 13);
      
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(mapRef.current);
    }

    if (mapRef.current) {
      const map = mapRef.current;
      const bounds = new L.LatLngBounds([]);

      Object.values(markersRef.current).forEach(marker => marker.remove());
      markersRef.current = {};

      const distributorIcon = L.divIcon({
        html: `<div class="bg-red-600 rounded-full w-6 h-6 flex items-center justify-center text-white font-bold border-2 border-white shadow-md">D</div>`,
        className: 'custom-div-icon',
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      });

      const distributorMarker = L.marker(
        [locationData.distributor.latitude, locationData.distributor.longitude],
        { icon: distributorIcon }
      ).addTo(map);

      distributorMarker.bindTooltip('Distributor (Starting Point)', {
        permanent: false,
        direction: 'top'
      });

      markersRef.current['distributor'] = distributorMarker;
      bounds.extend([locationData.distributor.latitude, locationData.distributor.longitude]);

      routes.forEach((route) => {
        route.stops.forEach((stop, stopIndex) => {
          bounds.extend([stop.latitude, stop.longitude]);

          const color = CLUSTER_COLORS[stop.clusterId % CLUSTER_COLORS.length];
          const customerIcon = L.divIcon({
            html: `
              <div class="bg-white rounded-full w-6 h-6 flex items-center justify-center text-xs font-medium border-2 cursor-move transition-all hover:scale-110" 
                   style="border-color: ${color}; color: ${color}">
                ${stopIndex + 1}
              </div>
            `,
            className: 'custom-div-icon',
            iconSize: [24, 24],
            iconAnchor: [12, 12]
          });

          const marker = L.marker([stop.latitude, stop.longitude], {
            icon: customerIcon,
            draggable: true,
            opacity: selectedCluster === null || stop.clusterId === selectedCluster ? 1 : 0
          }).addTo(map);

          markersRef.current[stop.customerId] = marker;

          marker.on('dragstart', () => {
            setDraggedStop({ stop, routeIndex });
            setIsDragging(true);
            setOriginalPosition({ lat: stop.latitude, lng: stop.longitude });
          });

          marker.on('drag', (e) => {
            if (!draggedStop) return;

            const markerLatLng = e.target.getLatLng();
            let nearestRouteIndex = null;
            let minDistance = Infinity;

            routes.forEach((r, idx) => {
              if (idx === routeIndex) return;

              const routePoints = r.stops.map(s => L.latLng(s.latitude, s.longitude));
              routePoints.forEach((point, i) => {
                if (i < routePoints.length - 1) {
                  const nextPoint = routePoints[i + 1];
                  const distance = L.LineUtil.pointToSegmentDistance(
                    [markerLatLng.lat, markerLatLng.lng],
                    [point.lat, point.lng],
                    [nextPoint.lat, nextPoint.lng]
                  );
                  if (distance < minDistance) {
                    minDistance = distance;
                    nearestRouteIndex = idx;
                  }
                }
              });
            });

            setHighlightedRoute(nearestRouteIndex);
            updateRouteDisplay();
          });

          marker.on('dragend', (e) => {
            if (!draggedStop) return;

            const markerLatLng = e.target.getLatLng();
            setDragEndPosition(markerLatLng);

            if (highlightedRoute !== null && highlightedRoute !== routeIndex) {
              const newRoutes = [...routes];
              newRoutes[routeIndex].stops = newRoutes[routeIndex].stops.filter(
                s => s.customerId !== draggedStop.stop.customerId
              );

              const updatedStop = {
                ...draggedStop.stop,
                latitude: markerLatLng.lat,
                longitude: markerLatLng.lng
              };

              newRoutes[highlightedRoute].stops.push(updatedStop);
              const recalculatedRoutes = recalculateRouteMetrics(newRoutes);
              setPendingRouteUpdate(recalculatedRoutes);
              setShowConfirmation(true);
            } else {
              const newRoutes = [...routes];
              const stopIndex = newRoutes[routeIndex].stops.findIndex(
                s => s.customerId === draggedStop.stop.customerId
              );
              
              if (stopIndex !== -1) {
                newRoutes[routeIndex].stops[stopIndex] = {
                  ...newRoutes[routeIndex].stops[stopIndex],
                  latitude: markerLatLng.lat,
                  longitude: markerLatLng.lng
                };
                const recalculatedRoutes = recalculateRouteMetrics(newRoutes);
                onRouteUpdate?.(recalculatedRoutes);
              }
            }

            setDraggedStop(null);
            setIsDragging(false);
            setHighlightedRoute(null);
          });

          marker.bindTooltip(
            `Customer: ${stop.customerId}<br>` +
            `Stop #${stopIndex + 1} for Salesman ${route.salesmanId}<br>` +
            `Cluster: ${stop.clusterId}`,
            { direction: 'top' }
          );
        });
      });

      updateRouteDisplay();

      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [30, 30] });
      }
    }

    return () => {
      Object.values(markersRef.current).forEach(marker => marker.remove());
      markersRef.current = {};
      routeLayersRef.current.forEach(layer => layer.remove());
      routeLayersRef.current = [];
    };
  }, [locationData, routes, selectedCluster, selectedSalesman]);

  useEffect(() => {
    if (mapRef.current && routes.length > 0) {
      createClusterPolygons();
    }
  }, [routes, selectedCluster]);

  return (
    <div className="flex flex-col h-full">
      <div className="mb-4">
        <h2 className="text-xl font-semibold text-gray-800">Route Visualization</h2>
        <p className="text-gray-600 text-sm">Filter routes by cluster and salesman</p>
      </div>

      <div className="mb-4 space-y-4">
        <div>
          <h3 className="text-sm font-medium text-gray-700 mb-2">Filter by Cluster</h3>
          <div className="flex flex-wrap gap-2">
            <button
              className={`px-3 py-1.5 rounded-full text-sm transition-all ${
                selectedCluster === null 
                  ? 'bg-gray-800 text-white' 
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
              onClick={() => {
                setSelectedCluster(null);
                updateRouteDisplay();
              }}
            >
              All Clusters
            </button>
            {Object.entries(clusterStats).map(([clusterId, stats]) => (
              <button
                key={clusterId}
                className={`px-3 py-1.5 rounded-full text-sm transition-all flex items-center gap-2 ${
                  selectedCluster === Number(clusterId)
                    ? 'bg-gray-800 text-white' 
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
                onClick={() => {
                  setSelectedCluster(Number(clusterId));
                  updateRouteDisplay();
                }}
              >
                <div 
                  className="w-3 h-3 rounded-full" 
                  style={{ backgroundColor: CLUSTER_COLORS[Number(clusterId) % CLUSTER_COLORS.length] }}
                ></div>
                <span>Cluster {clusterId}</span>
                <span className="text-xs opacity-75">
                  ({stats.count} outlets, {stats.distance.toFixed(1)} km)
                </span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <h3 className="text-sm font-medium text-gray-700 mb-2">Filter by Salesman</h3>
          <div className="flex flex-wrap gap-2">
            <button
              className={`px-3 py-1.5 rounded-full text-sm transition-all ${
                selectedSalesman === null 
                  ? 'bg-gray-800 text-white' 
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
              onClick={() => {
                setSelectedSalesman(null);
                updateRouteDisplay();
              }}
            >
              All Salesmen
            </button>
            {routes.map((route) => (
              <button
                key={route.salesmanId}
                className={`px-3 py-1.5 rounded-full text-sm transition-all flex items-center gap-2 ${
                  selectedSalesman === route.salesmanId 
                    ? 'bg-gray-800 text-white' 
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
                onClick={() => {
                  setSelectedSalesman(route.salesmanId);
                  updateRouteDisplay();
                }}
              >
                <span>Salesman {route.salesmanId}</span>
                <span className="text-xs opacity-75">
                  ({route.stops.length} stops)
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div 
        ref={mapContainerRef} 
        className="flex-grow rounded-lg shadow-md border border-gray-200 min-h-[500px]"
      ></div>

      {showConfirmation && pendingRouteUpdate && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              Confirm Route Change
            </h3>
            <p className="text-gray-600 mb-4">
              Are you sure you want to move this customer to another route? This will create a custom solution for comparison.
            </p>
            <div className="flex justify-end gap-3">
              <button
                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-md transition-colors"
                onClick={handleCancelRouteChange}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors"
                onClick={handleConfirmRouteChange}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MapView;